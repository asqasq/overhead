/**
 * This is a test tool for measuring the performance of OpenWhisk actions and rules. 
 * The full documentation of the tool is available in README.md .
 */

const fs = require('fs');
const ini = require('ini');
const cluster = require('cluster');
const openwhisk = require('openwhisk');
const program = require('commander');
const exec = require('node-exec-promise').exec;
const sqlite3 = require('sqlite3').verbose();

const ACTION = "action";
const RULE = "rule";
const RESULT = "result";
const ACTIVATION = "activation";
const NONE = "none";

function parseIntDef(strval, defval) {
	return parseInt(strval);
}

program
	.description('Latency and throughput measurement of OpenWhisk actions and rules')
	.version('0.0.1')
	.option('-a, --activity <action/rule>', "Activity to measure", /^(action|rule)$/i, "action")
	.option('-b, --blocking <result/activation/none>', "For actions, wait until result or activation, or don't wait", /^(result|activation|none)$/i, "none")
	.option('-d, --delta <msec>', "Time diff between consequent invocations of the same worker, in msec", parseIntDef, 200)
	.option('-i, --iterations <count>', "Number of measurement iterations", parseInt)
	.option('-p, --period <msec>', "Period of measurement in msec", parseInt)
	.option('-r, --ratio <count>', "How many actions per iteration (or rules per trigger)", parseIntDef, 1)
	.option('-s, --parameter_size <size>', "Size of string parameter passed to trigger or actions", parseIntDef, 1000)
	.option('-w, --workers <count>', "Total number of concurrent workers incl. master", parseIntDef, 1)
	.option('-A, --master_activity <action/rule>', "Set master activity apart from other workerss", /^(action|rule)$/i)   
	.option('-B, --master_blocking <result/activation/none>', "Set master blocking apart from other workers", /^(result|activation|none)$/i)
	.option('-D, --master_delta <msec>', "Set master delta apart from other workers", parseInt)
	.option('-u, --warmup <count>', "How many invocations to perform at each worker as warmup", parseIntDef, 5)
	.option('-l, --delay <msec>', "How many msec to delay at each action", parseIntDef, 50)
	.option('-P --pp_delay <msec>', "Wait for remaining activations to finalize before post-processing", parseIntDef, 60000)
	.option('-G --burst_timing', "For actions, use the same invocation timing (BI) for all actions in a burst")
	.option('-S --no-setup', "Skip test setup (so use previous setup)")
	.option('-T --no-teardown', "Skip test teardown (to allow setup reuse)")
	.option('-f --config_file <filepath>', "Specify a wskprops configuration file to use", `${process.env.HOME}/.wskprops`)
	.option('-q, --quiet', "Suppress progress information on stderr")
  .option('-3, --sql <dbfilename>', "Store measurement values in sqlite3 database file")
  .option('-g, --gigabits <Gbit/s>', "The network speed for this experiment in Gbit/s", parseIntDef, 1);

program.parse(process.argv);

var testRecord = {input: {}, output: {}};	// holds the final test data

for (var opt in program.opts())
	if (typeof program[opt] != 'function') 
		testRecord.input[opt] = program[opt];

/*
// if sql is set, connect to DB file
if (testRecord.input.sql) {
  mLog(`CONNECT TO DATABASE ${testRecord.input.sql}\n`);
  testRecord.input.sqldb = connectToDB(testRecord.input.sql);
} else {
  mLog("Do not store measurements to database.\n");
}
*/

// If neither period nor iterations are set, then period is set by default to 1000 msec
if (!testRecord.input.iterations && !testRecord.input.period)
	testRecord.input.period = 1000;

// If either master_activity, master_blocking or master_delta are set, then test is in 'master apart' mode
testRecord.input.master_apart = ((testRecord.input.master_activity || testRecord.input.master_blocking || testRecord.input.master_delta) && true);

mLog("Parameter Configuration:");
for (var opt in testRecord.input)
	mLog(`${opt} = ${testRecord.input[opt]}`);
mLog("-----\n");

mLog("Generating invocation parameters");
var inputMessage = "A".repeat(testRecord.input.parameter_size);
var params = {sleep: testRecord.input.delay, message: inputMessage};

mLog("Loading wskprops");
const config = ini.parse(fs.readFileSync(testRecord.input.config_file, "utf-8"));
mLog("APIHOST = " + config.APIHOST);
mLog("AUTH = " + config.AUTH);
mLog("-----\n");
const wskParams = `--apihost ${config.APIHOST} --auth ${config.AUTH} -i`;	// to be used when invoking setup and teardown via external wsk

// openwhisk client used for invocations
const ow = openwhisk({apihost: config.APIHOST, api_key: config.AUTH, ignore_certs: true});
 
// counters for throughput computation (all)
const tpCounters = {attempts: 0, invocations: 0, activations: 0, requests: 0, errors: 0};	

// counters for latency computation
const latCounters = {
					ta: {sum: undefined, sumSqr: undefined, min: undefined, max: undefined}, 
					oea: {sum: undefined, sumSqr: undefined, min: undefined, max: undefined}, 
					oer: {sum: undefined, sumSqr: undefined, min: undefined, max: undefined}, 
					d: {sum: undefined, sumSqr: undefined, min: undefined, max: undefined}, 
					ad: {sum: undefined, sumSqr: undefined, min: undefined, max: undefined},
					ora: {sum: undefined, sumSqr: undefined, min: undefined, max: undefined},
					rtt: {sum: undefined, sumSqr: undefined, min: undefined, max: undefined},
					ortt: {sum: undefined, sumSqr: undefined, min: undefined, max: undefined}
};

const measurementTime = {start: -1, stop: -1};

const sampleData = [];	// array of samples (tuples of collected invocation data, for rule or for action, depending on the activity)

var loopSleeper;	// used to abort sleep in mainLoop()
var abort = false;	// used to abort the loop in mainLoop()

// Used only at the master
var workerData = [];	// holds data for each worker, at [1..#workers]. Master's entry is 0.

const activity = ((cluster.isWorker || !testRecord.input.master_activity) ? testRecord.input.activity : testRecord.input.master_activity);

if (cluster.isMaster) {
    sql_open_db().then((db) => {
        sql_create_tables(db).then(() => {
          sql_create_experimentId(db).then((expId) => {
            sql_get_next_id(db, testRecord.input.gigabits).then((expId) => {
              testRecord.input.db = db;
              testRecord.input.expId = expId;

              runMaster();
            });
          });
        });
    });
} else {
    sql_open_db().then((db) => {
      sql_get_next_id(db, testRecord.input.gigabits).then((expId) => {
        testRecord.input.db = db;
        testRecord.input.expId = expId;

        runWorker();
      });
    });
}


// -------- END OF MAIN -------------

/**
 * Master operation
 */
function runMaster() {

	// Setup OpenWhisk assets for the test
	testSetup().then(() => {



		// Start workers, configure interaction
		for(var i = 0; i < testRecord.input.workers; i++) {
			if (i > 0)		// fork only (workers - 1) times 
				cluster.fork();
		}

		for (const id in cluster.workers) {

			// Exit handler for each worker
			cluster.workers[id].on('exit', (code, signal) => {
				if (signal) 
					mLog(`Worker ${id} was killed by signal: ${signal}`);
				else 
					if (code !== 0) 
						mLog(`Worker ${id} exited with error code: ${code}`);
				checkExit();
			});

			// Message handler for each worker
			cluster.workers[id].on('message', (msg) => {
				if (msg.init) 
					// Initialization barrier for workers. Makes sure they are all fully engaged when the measurement start
					checkInit();

				if (msg.summary) {
					workerData[id] = msg.summary;
					checkSummary();
				}
			});
		}

		mainLoop().then(() => {

			// set finish of measurement and notify all other workers
			measurementTime.stop = new Date().getTime();
			testRecord.output.measure_time = (measurementTime.stop - measurementTime.start) / 1000.0;	// measurement duration converted to seconds
			mLog(`Stop measurement. Start post-processing after ${testRecord.input.pp_delay} msec`);
			mLogSampleHeader();
			for (const j in cluster.workers) 
				cluster.workers[j].send({abort: measurementTime});

			// The master's post-processing to generate its workerData
			sleep(testRecord.input.pp_delay)
				.then(() => {
					postProcess()
					.then(() => {
						// The master's workerData
						workerData[0] = {lat: latCounters, tp: tpCounters};
						checkSummary();
            sql_close_db(testRecord.input.db);
					})
					.catch(err => {	// FATAL - shouldn't happen unless BUG
						mLog(`Post-process ERROR in MASTER: ${err}`);
						throw err;
					});
				});
		});


	});

}


/**
 * Setup assets before the test depending on configuration
 */
async function testSetup() {

	if (!testRecord.input.setup)
		return;

	const cmd = `./setup.sh s ${testRecord.input.ratio} ${wskParams}`;
	mLog(`SETUP: ${cmd}`);
			
	try {
		await exec(cmd);
	}
	catch (error) {
		mLog(`FATAL: setup failure - ${error}`);
		process.exit(-2);
	}
}


/**
 * Teardown assets after the test depending on configuration
 */
async function testTeardown() {

	if (!testRecord.input.teardown)
		return;

	const cmd = `./setup.sh t ${testRecord.input.ratio} ${wskParams}`;
	mLog(`TEARDOWN: ${cmd}`);
			
	try {
		await exec(cmd);
	}
	catch (error) {
		mLog(`WARNING: teardown error - ${error}`);
		process.exit(-3);
	}
}


/**
 * Print table header for samples to the runtime log on stderr
 */
function mLogSampleHeader() {
	mLog("bi,\tas,\tae,\tts,\tta,\toea,\toer,\td,\tad,\tai,\tora,\trtt,\tortt");
}

/**
 * Worker operation
 */
function runWorker() {

	// abort message from master will set the measurement time frame and abort the loop
	process.on('message', (msg) => {
		if (msg.abort) {
			// Set the measurement time frame at the worker - required for post-processing
			measurementTime.start = msg.abort.start;
			measurementTime.stop = msg.abort.stop;
			abortLoop();
		}
	});

	mainLoop().then(() => {
		sleep(testRecord.input.pp_delay)
			.then(() => {
        sleep(cluster.worker.id * 1000)
          .then(() => {
            postProcess()
              .then(() => {
                process.send({summary:{lat: latCounters, tp:tpCounters}});
                sql_close_db(testRecord.input.db);
                process.exit();
              })
              .catch(err => {	// shouldn't happen unless BUG
                mLog(`Post-process ERROR in WORKER: ${err}`);
                throw err;
              });
				  });
      });
	});
}


// Barrier for checking all workers have initialized and then start measurement

var remainingInits = testRecord.input.workers;
var remainingIterations = -1;

function checkInit() {
	remainingInits--;
	if (remainingInits == 0) {	// all workers are engaged (incl. master) - can start measurement
		mLog("All clients finished warmup. Start measurement.");
		measurementTime.start = new Date().getTime();

		if (testRecord.input.period)
			setTimeout(abortLoop, testRecord.input.period);

		if (testRecord.input.iterations)
			remainingIterations = testRecord.input.iterations;
	}
}

// Barrier for checking all workers have finished, generate output and exit

var remainingExits = testRecord.input.workers;

function checkExit() {
	remainingExits--;
	if (remainingExits == 0) {
		mLog("All workers finished - generating output and exiting.");
		generateOutput();
		// Cleanup test assets from OW and then exit
		testTeardown().then(() => {
			mLog("Done");
			process.exit();
		});
	}
}

// Barrier for receiving post-processing results from all workers before computing final results

var remainingSummaries = testRecord.input.workers;

function checkSummary() {
	remainingSummaries--;
	if (remainingSummaries == 0) {
		mLogSampleHeader();
		mLog("All clients post-processing completed - computing output.")
		computeOutputRecord();
		checkExit();
	}
}


/**
 * Main loop for invocations - invoke activity asynchronously once every (delta) msec until aborted 
 */
async function mainLoop() {

	var warmupCounter = testRecord.input.warmup;
	const delta = ((cluster.isWorker || !testRecord.input.master_delta) ? testRecord.input.delta : testRecord.input.master_delta);
	const blocking = ((cluster.isWorker || !testRecord.input.master_blocking) ? testRecord.input.blocking : testRecord.input.master_blocking);
	const doBlocking = (blocking != NONE);
	const getResult = (blocking == RESULT);

	while (!abort) {

		// ----
		// Pass init (worker - send message) after <warmup> iterations
		if (warmupCounter == 0) {
			if (cluster.isMaster) 
				checkInit();
			else 	// worker - send init
				process.send({init: 1});
		}

		if (warmupCounter >= 0)		// take 0 down to -1 to make sure it does not trigger another init message
			warmupCounter--;
		// ----

		// If iterations limit set, abort loop when finished iterations
		if (remainingIterations == 0) {
			abortLoop();
			continue;
		}

		if (remainingIterations > 0)
			remainingIterations--;

		const si = new Date().getTime();	// SI = Start of Iteration timestamp 

		var samples;

		if (activity == ACTION) 
			samples = await invokeActions(testRecord.input.ratio, doBlocking, getResult, si);
		else 
			samples = await invokeRules(si);

		samples.forEach(sample => {
			sampleData.push(sample);
		});

		const ei = new Date().getTime();	// EI = End of Iteration timestamp
		const duration = ei - si;
		if (delta > duration) {
			loopSleeper = sleep(delta - duration);
			if (!abort)		// check again to avoid race condition on loopSleeper
				await loopSleeper;
		}
	}	
}


/**
 * Used to abort the mainLoop() function
 */
function abortLoop() {
	abort = true;
	if (loopSleeper)
		loopSleeper.resolve();
}


/**
 * Invoke the predefined OW action a specified number of times without waiting using Promises (burst).
 * Returns a promise that resolves to an array of {id, isError}.
 */
function invokeActions(count, doBlocking, getResult, burst_bi) {
	return new Promise( function (resolve, reject) {
		var ipa = [];	// array of invocation promises;
		for(var i = 0; i< count; i++) {
			ipa[i] = new Promise((resolve, reject) => {
				const bi = (testRecord.input.burst_timing ? burst_bi : new Date().getTime());  // default is BI per invocation
				ow.actions.invoke({name: 'testAction', blocking: doBlocking, result: getResult, params: params})
					// If returnedJSON is full activation or just activation ID then activation ID should be in "activationId" field
					// If returnedJSON is the result of the test action, then "activationId" is part of the returned result of the test action
					.then(returnedJSON => {
						var ai;	// after invocation
						if (doBlocking)
							ai = new Date().getTime(); 	// only for blocking invocations, AI is meaningful
						resolve({aaid: returnedJSON.activationId, bi: bi, ai: ai});
					})
					.catch(err => {
						resolve({aaidError: err});
					});
			});
		}

		Promise.all(ipa).then(ipArray => {
			resolve(ipArray);
		}).catch(err => {	// Impossible to reach since no contained promise rejects
			reject(err);
		});

	});
}
		

/**
 * Invoke the predefined OW rules asynchronously and return a promise of an array with a single element of {id, isError} 
 */
function invokeRules(bi) {
	return new Promise( function (resolve, reject) {
		const triggerSamples = [];
		// Fire trigger to invoke the rule
		ow.triggers.invoke({name: 'testTrigger', params: params})
			.then(triggerActivationIdJSON => {
				const triggerActivationId = triggerActivationIdJSON.activationId;
				triggerSamples.push({taid: triggerActivationId, bi: bi});
				resolve(triggerSamples);
			})
			.catch (err => {
				triggerSamples.push({taidError: err});
				resolve(triggerSamples);
			});
	});
}


/**
 * This function processes the sampleData. Each sample is processed as following:
 * 1. A sample with error (TAID or AAID) is processed directly (not much to do beyond counting errors)
 * 2. An action sample - first attempt to retrieve activation, then process with it
 * 3. A rule sample - first convert to set of bound action samples (by processing the trigger activation), then process each action sample in step 2 above 
  */
async function postProcess() {
	for(var i in sampleData) {
		const sample = sampleData[i];
		if (activity == ACTION) {
			await processSampleWithAction(sample);
		}
		else {		// activity == RULE
			if (sample.taidError)	// TAID error - no need to retrieve bound actions - move to process the sample directly
				processSample(sample);
			else {	// have valid TAID - retrieve bound action ids and then process
				const actionSamples = await getActionSamplesOfRules(sample);
				for(var j in actionSamples) 
					await processSampleWithAction(actionSamples[j]);
			}
		}
	}
}


/**
 * Retrieve the activation ids of the actions bound to the trigger activation provided by id.
 * Failure to retrieve trigger activation for a valid activation id is considered a fatal error, since the activation must exist.
 * @param {*} triggerActivation
 */
function getActionSamplesOfRules(triggerSample) {
	return new Promise((resolve, reject) => {
		ow.activations.get({name: triggerSample.taid})
			.then(triggerActivation => {
				triggerSample.ts = triggerActivation.start;
				var actionSamples = [];
				for(var i = 0; i < triggerActivation.logs.length; i++) {
					const boundActionRecord = JSON.parse(triggerActivation.logs[i]);
					const actionSample = Object.assign({}, triggerSample);
					if (boundActionRecord.success)
						actionSample.aaid = boundActionRecord.activationId;
					else
						actionSample.aaidError = boundActionRecord.error;
					actionSamples.push(actionSample);
				}
				resolve(actionSamples);
			})
			.catch (err =>	{	// FATAL: failed to retrieve trigger activation for a valid id
				mLog(`getActionSamplesOfRules returned ERROR: ${err}`);
				reject(err);
			});
	});
}


/**
 * Processing each action sample sequentially, i.e., wait until activation is retrieved before retrieving the next one.
 * Otherwise, concurrent retrieval of possibly thousands of activations and more, may cause issues.
 * Failure to retrieve activation record for a valid id is ok, assuming the action may have not completed yet.
 * @param {*} actionSample
 */
async function processSampleWithAction(actionSample) {
	if (actionSample.aaidError)	// no activation, move on to processing sample with error
		processSample(actionSample);
	else {	// have activation, try to get record
		var activation;
		try {
			activation = await ow.activations.get({name: actionSample.aaid});
		}
		catch (err) {
			mLog(`Failed to retrieve activation for id: ${actionSample.aaid} for reason: ${err}`);
		}
		processSample(actionSample, activation);
	}
}


/**
 * Process a single sample + optional related action activation, updating latency and throughput counters
 * @param {*} sample
 */
function processSample(sample, activation) {

	const bi = sample.bi;

	if (bi < measurementTime.start || bi > measurementTime.stop)	{	// BI outside time frame. No further processing.
		mLog(`Sample discarded. BI exceeds measurement time frame: ${bi} < ${measurementTime.start} || ${bi} > ${measurementTime.stop}`);
		return;
	}

	tpCounters.attempts++;	// each sample invoked in the time frame counts as one invocation attempt

	if (sample.taidError) {	// trigger activation failed - count one request, one error. No further processing.
		tpCounters.requests++;
		tpCounters.errors++;
		mLog(`Sample discarded. Trigger activation error: ${sample.taidError}`);
		return;
	}

	var ts;
	if (sample.ts) {
		ts = parseInt(sample.ts);
	
		if (ts >= measurementTime.start && ts <= measurementTime.stop) {	// trigger activation in time frame - count one activation, one request
			tpCounters.activations++;
			tpCounters.requests++;
		}
	}
	else
		ts = undefined;

	if (sample.aaidError) {	// action activation failed - count one request, one error. No further processing.
		tpCounters.requests++;
		tpCounters.errors++;
		mLog(`Sample discarded. Action activation error: ${sample.aaidError}`);
		return;
	}

	if (!activation) {	// no activation, so assumed incomplete. No further processing.
		mLog(`Sample discarded. Activation was not retrieved.`)
		return;
	}

	const as = parseInt(activation.start);
	const ae = parseInt(activation.end);
	const d = parseInt(activation.response.result.duration);

	if (as < measurementTime.start || ae > measurementTime.stop) {	// got activation, but it exceeds the time frame. No further processing.
		mLog(`Sample discarded. Action activation exceeded measurement time frame: ${as} < ${measurementTime.start} || ${ae} > ${measurementTime.stop}`)
		return;
	}

	// Activation is in time frame, so count one activation, one request and one full invocation 
	tpCounters.activations++;
	tpCounters.requests++;
	tpCounters.invocations++;

	// For full invocations, update latency counters

	const ta = (ts ? as - ts : undefined);
	const ad = ae - as;
	const oea = as - bi;
	const oer = ae - bi - d;

	updateLatSample("d", d);
	updateLatSample("ta", ta);
	updateLatSample("ad", ad);
	updateLatSample("oea", oea);
	updateLatSample("oer", oer);

	// for blocking action invocations - will be "undefined" otherwise
	const ai = sample.ai;

	const ora = (ai ? ai - ae : undefined);
	const rtt = (ai ? ai - bi : undefined);
	const ortt = (rtt ? rtt - d : undefined);

	updateLatSample("ora", ora);
	updateLatSample("rtt", rtt);
	updateLatSample("ortt", ortt);

	mLog(`${bi},\t${as},\t${ae},\t${ts},\t${ta},\t${oea},\t${oer},\t${d},\t${ad},\t${ai},\t${ora},\t${rtt},\t${ortt}`);

  if (testRecord.input.sql) {
    sql_insert_workersample(testRecord.input.db, testRecord.input.expId, bi, as, ae, ts, ta, oea, oer, d, ad, ai, ora, rtt, ortt);
  }
}

/**
 * Update counters of one latency statistic of a worker with value data from one sample
 */
function updateLatSample(statName, value) {

	if (!value) 	// value == undefined => skip it
		return;

	// Update sum for avg
	if (!latCounters[statName].sum)
		latCounters[statName].sum = 0;
	latCounters[statName].sum += value;

	// Update sumSqr for std
	if (!latCounters[statName].sumSqr)
		latCounters[statName].sumSqr = 0;
	latCounters[statName].sumSqr += value * value;

	// Update min value
	if (!latCounters[statName].min || latCounters[statName].min > value)
		latCounters[statName].min = value;

	// Update max value
	if (!latCounters[statName].max || latCounters[statName].max < value)
		latCounters[statName].max = value;
}


/**
 * Compute the final output record based on the workerData records.
 * The output of the program is a single CSV row of data consisting of the input parameters, 
 * then latencies computed above - avg (average) and std (std. dev.), then throughput.
 */
function computeOutputRecord() {

	// Latency stats: avg, std, min, max
	["ta", "oea", "oer", "d", "ad", "ora", "rtt", "ortt"].forEach(statName => {
		testRecord.output[statName] = computeLatStats(statName);
	});

	// Tp stats: abs, tp, tpw, tpd
	["attempts", "invocations", "activations", "requests"].forEach(statName => {
		testRecord.output[statName] = computeTpStats(statName);
	});

	// Error stats: abs, percent
	testRecord.output.errors = computErrorStats();
}


/**
 * Based on workerData, compute average and standard deviation of a given latency statistic.
 * @param {*} statName 
 */
function computeLatStats(statName) {
	var totalSum = 0;
	var totalSumSqr = 0;
	var totalInvocations = 0;
	var hasSamples = undefined;	// does the current stat have any samples. If not => undefined, not NaN
	var min = undefined;
	var max = undefined;
	if (testRecord.input.master_apart) {	// in master_apart mode, only master performs latency measurements
		totalSum = workerData[0].lat[statName].sum;
		totalSumSqr = workerData[0].lat[statName].sumSqr;
		min = workerData[0].lat[statName].min;
		max = workerData[0].lat[statName].max;
		totalInvocations = workerData[0].tp.invocations;
	}
	else // in regular mode, all workers participate in latency measurements
		workerData.forEach(wd => {
			if (wd.lat[statName].sum) {	// If this worker has valid latency samples (not undefined)
				hasSamples = 1;
				totalSum += wd.lat[statName].sum;
				totalSumSqr += wd.lat[statName].sumSqr;
				if (!min || min > wd.lat[statName].min)
					min = wd.lat[statName].min;
				if (!max || max < wd.lat[statName].max)
					max = wd.lat[statName].max;
			}
			totalInvocations += wd.tp.invocations;
		});

	const avg = (hasSamples ? totalSum / totalInvocations : undefined);
	const std = (hasSamples ? Math.sqrt(totalSumSqr / totalInvocations - avg * avg) : undefined);

	return ({avg: avg, std: std, min: min, max: max});
}


/**
 * Based on workerData, compute throughput of a given counter, with (tp) and without (tpw) the master, and the percent difference (tpd)
 * @param {*} statName 
 */
function computeTpStats(statName) {
	var masterCount = workerData[0].tp[statName];
	var totalCount = 0;
	workerData.forEach(wd => {totalCount += wd.tp[statName];});
	const tp = totalCount / testRecord.output.measure_time;			// throughput
	const tpw = (totalCount - masterCount) / testRecord.output.measure_time;		// throughput without master
	const tpd = (tp - tpw) * 100.0 / tp;		// percent difference relative to TP

	return ({abs: totalCount, tp: tp, tpw: tpw, tpd: tpd});
}


/**
 * Based on workerData, compute the relative portion of total errors out of total requests
 */
function computErrorStats() {
	var totalErrors = 0;
	var totalRequests = 0;

	workerData.forEach(wd => { 
		totalErrors += wd.tp.errors;
		totalRequests += wd.tp.requests;
	});

	const errAbs = totalErrors;
	const errPer = totalErrors * 100.0 / totalRequests;
	return ({abs: errAbs, percent: errPer});
}


/**
 * Generate a properly formatted output record to stdout. The header is also printed, but via mDump to stderr and can be
 * silenced.
 */
function generateOutput() {
	var first = true;
  
  console.log("+++++++++++++ GENERATING OUTPUT +++++++++++++++++++++\n");

	// First, print header to stderr
	dfsObject(testRecord, (name, data, isRoot, isObj) => {
		if (!isObj) {		// print leaf nodes
			if (!first)
				mWrite(",\t");
			first = false;
			mWrite(`${name}`);
		}
	});
	mWrite("\n");

  console.log("################# GENERATING NUMBER OUTPUT #########################\n");

	first = true;

	// Now, print data to stdout
	dfsObject(testRecord, (name, data, isRoot, isObj) => {
		if (!isObj) {		// print leaf nodes
			if (!first)
				process.stdout.write(",\t");
			first = false;
			if (typeof data == 'number')	// round each number to 3 decimal digits
				data = round(data, 3);
			process.stdout.write(`${data}`);
		}
	});
	process.stdout.write("\n");

  console.log("||||||||||||||||||||||||||||||||||||||| Put into SQL ||||||||||||||||||||||||||||||||||||||\n");
  columnNames = [];
  columnValues = [];
	dfsObject(testRecord, (name, data, isRoot, isObj) => {
		if (!isObj) {		// print leaf nodes
			if (typeof data == 'number')	// round each number to 3 decimal digits
				data = round(data, 3);
      if (!data)
        data = "NULL";
      //console.log("INSERT INTO summarymeasurements(" + `${name}` + ") VALUES(" + `${data}` + ");");
      n = name.replace(/\./g, "_");
      columnNames.push(`${n}`);
      columnValues.push("\'" + `${data}` + "\'");
		}
	});
  sql_open_db().then((db) => {
    process.stdout.write("INSERT INTO summaryMeasurements(" + columnNames + ") VALUES(" + columnValues + ");");
    sql_insert_summary(db, testRecord.input.expId, columnNames, columnValues)
	  process.stdout.write("\n");
    sql_close_db(db);
  });
}


/**
 * Sleep for a given time. Useful mostly with await from an async function
 * resolve and reject are externalized as properties to allow early abortion
 * @param {*} ms 
 */
function sleep(ms) {
	var res, rej;
	var p = new Promise((resolve, reject) => {
		setTimeout(resolve, ms);
		res = resolve;
		rej = reject;
	});
	p.resolve = res;
	p.reject = rej;

	return p;
  }
  

/**
 * Generate a random integer in the range of [1..max]
 * @param {*} max 
 */
function getRandomInt(max) {
	return Math.floor(Math.random() * Math.floor(max) + 1);
  }


/**
 * Round a number after specified decimal digits
 * @param {*} num 
 * @param {*} digits 
 */
  function round(num, digits = 0) {
	const factor = Math.pow(10, digits);
	return Math.round(num * factor) / factor;
}


// If not quiet, emit control messages on stderr (with newline) 
function mLog(text) {
	if (!testRecord.input.quiet)
		console.error(`${clientId()}:\t${text}`);
}


/**
 * Return the id of the client - MASTER-0 or WORKER-k (k=1..w-1)
 */
function clientId() {
	return (cluster.isMaster ? "MASTER-0" : `WORKER-${cluster.worker.id}`); 
}


// If not quiet, write strings on stderr (w/o newline)
function mWrite(text) {
	if (!testRecord.input.quiet)
		process.stderr.write(text);
}

/**
 * Traverse a (potentially deep) object in DFS, visiting each non-function node with function f 
 * @param {*} data 
 * @param {*} func 
 */
function dfsObject(data, func, allowInherited = false) {
	var isRoot = true;
	var rootObj = data;
	crawlObj("", data, func, allowInherited);

	function crawlObj(name, data, f, allowInherited) {
		var isObj = (typeof data == 'object');
		var isFunc = (typeof data == 'function');
		if (!isFunc)
			f(name, data, isRoot, isObj);	// visit the current node
		isRoot = false;
		if (isObj)
			for (var child in data) {
				if (allowInherited || data.hasOwnProperty(child)) {
					const childName = (name == "" ? child : name + "." + child);
					crawlObj(childName, data[child], f, true);	// After root level no need to check inheritance
				}
			}
	} 
}

async function sql_open_db() {
    var p = new Promise((resolve, reject) => {
        // if sql is set, connect to DB file
        if (testRecord.input.sql) {
          mLog(`CONNECT TO DATABASE ${testRecord.input.sql}\n`);

        let db = new sqlite3.Database(testRecord.input.sql, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
        if (err) {
            console.log('bloed');
            console.error(err.message);
            reject(err);
        }
        console.log('Connected to the database.');
        resolve(db);
        });
        } else {
          mLog("Do not store measurements to database.\n");
          resolve(testRecord.input.sql);
        // open the database
        }
    });
    var db = await p;
    return db;
}


function sql_close_db(database) {
  if (database) {
    mLog("Closing database...");
	  database.close((err) => {
    if (err) {
        console.log('bloeder');
        console.error(err.message);
    }
    console.log('Close the database connection.');
    });
  } else {
    console.log('Database WAS closed.');
  }
}



async function sql_create_experimentId(db, gigabits) {
    if (db) {
      var p2;
      var p = new Promise((resolve, reject) => {
          db.run('INSERT INTO experimentId(experimentDate, gigabits) VALUES(CURRENT_TIMESTAMP, ?);', [gigabits], function(err) {
              if (err) {
                  console.log("\n\n*******************\n\n");
                  console.log(err.message);
                  reject(err);
              }
              console.log(`A row has been inserted with rowid ${this.lastID}`);
              resolve(0);
          });
      });
      await p;
  }
  return;
}

async function sql_get_next_id(db) {
    p2 = new Promise((resolve, reject) => {
        db.serialize(() => {
          db.each('SELECT id from experimentId order by id desc limit 1;', (err, row) => {
            if (err) {
              console.log("\n\n----------------------\n\n");
              console.error(err.message);
              reject(err);
            }
            console.log("ROW:" + row.id + "\n");
            resolve(row.id);
          });
        });
    });

    const id = await p2;
    console.log(`last ID = ${id}`);

    return id;
}


/******************************************************************************/
/* create database tables */

function sql_create_table_1(db) {
    return new Promise((resolve, reject) => {
        db.run('CREATE TABLE IF NOT EXISTS workersamples(experimentId INTEGER, \
                bi INTEGER, \
                asv INTEGER, \
                ae INTEGER, \
                ts INTEGER, \
                ta INTEGER, \
                oea INTEGER, \
                oer INTEGER, \
                d INTEGER, \
                ad INTEGER, \
                ai INTEGER, \
                ora INTEGER, \
                rtt INTEGER, \
                ortt INTEGER, \
                FOREIGN KEY(experimentId) REFERENCES experimentId(id));', function(err) {
                if (err) {
                    console.log(err.message);
                    reject(err);
                } else {
                    console.log('table created');
                    resolve(1);
                }
        });
    });
}




function sql_create_table_2(db) {
    return new Promise((resolve, reject) => {
        db.run('CREATE TABLE IF NOT EXISTS summaries(experimentId INTEGER, \
                 avg FLOAT, FOREIGN KEY(experimentId) REFERENCES experimentId(id));', function(err) {
                if (err) {
                    console.log(err.message);
                    reject(err);
                } else {
                    console.log('table created');
                    resolve(2);
                }
        });
    });
}

function sql_create_table_3(db) {
    return new Promise((resolve, reject) => {
        db.run('CREATE TABLE IF NOT EXISTS experimentId(id INTEGER PRIMARY KEY AUTOINCREMENT, experimentDate DATE, \
                gigabits INTEGER);', function(err) {
                if (err) {
                    console.log(err.message);
                    reject(err);
                }
                console.log('table created');
                resolve(3);
        });
    });

}


function sql_create_table_4(db) {
    return new Promise((resolve, reject) => {
        db.run('CREATE TABLE IF NOT EXISTS summaries(experimentId INTEGER, \
                 avg FLOAT, FOREIGN KEY(experimentId) REFERENCES experimentId(id));', function(err) {
                if (err) {
                    console.log(err.message);
                    reject(err);
                } else {
                    console.log('table created');
                    resolve(4);
                }
        });
    });
}

function sql_create_table_5(db) {
    return new Promise((resolve, reject) => {
        db.run('CREATE TABLE IF NOT EXISTS measurementSummary( \
                input_activity TEXT, \
                input_blocking TEXT, \
                input_delta REAL, \
                input_iterations REAL, \
                input_period REAL, \
                input_ratio REAL, \
                input_parameter_size REAL, \
                input_workers REAL, \
                input_master_activity TEXT, \
                input_master_blocking TEXT, \
                input_master_delta REAL, \
                input_warmup REAL, \
                input_delay REAL, \
                input_pp_delay REAL, \
                input_burst_timing REAL, \
                input_setup INTEGER, \
                input_teardown INTEGER, \
                input_config_file TEXT, \
                input_quiet INTEGER, \
                input_sql TEXT, \
                input_gigabits REAL, \
                input_master_apart REAL, \
                input_db_open INTEGER, \
                input_db_filename TEXT, \
                input_db_mode REAL, \
                input_db_domain REAL, \
                input_db__events REAL, \
                input_db__maxListeners REAL, \
                input_expId INTEGER, \
                output_measure_time REAL, \
                output_ta_avg REAL, \
                output_ta_std REAL, \
                output_ta_min REAL, \
                output_ta_max REAL, \
                output_oea_avg REAL, \
                output_oea_std REAL, \
                output_oea_min REAL, \
                output_oea_max REAL, \
                output_oer_avg REAL, \
                output_oer_std REAL, \
                output_oer_min REAL, \
                output_oer_max REAL, \
                output_d_avg REAL, \
                output_d_std REAL, \
                output_d_min REAL, \
                output_d_max REAL, \
                output_ad_avg REAL, \
                output_ad_std REAL, \
                output_ad_min REAL, \
                output_ad_max REAL, \
                output_ora_avg REAL, \
                output_ora_std REAL, \
                output_ora_min REAL, \
                output_ora_max REAL, \
                output_rtt_avg REAL, \
                output_rtt_std REAL, \
                output_rtt_min REAL, \
                output_rtt_max REAL, \
                output_ortt_avg REAL, \
                output_ortt_std REAL, \
                output_ortt_min REAL, \
                output_ortt_max REAL, \
                output_attempts_abs REAL, \
                output_attempts_tp REAL, \
                output_attempts_tpw REAL, \
                output_attempts_tpd REAL, \
                output_invocations_abs REAL, \
                output_invocations_tp REAL, \
                output_invocations_tpw REAL, \
                output_invocations_tpd REAL, \
                output_activations_abs REAL, \
                output_activations_tp REAL, \
                output_activations_tpw REAL, \
                output_activations_tpd REAL, \
                output_requests_abs REAL, \
                output_requests_tp REAL, \
                output_requests_tpw REAL, \
                output_requests_tpd REAL, \
                output_errors_abs REAL, \
                output_errors_percent REAL \
                );', function(err) {
                if (err) {
                    console.log(err.message);
                    reject(err);
                } else {
                    console.log('table created');
                    resolve(1);
                }
        });
    });
}


async function sql_create_tables(db) {
    if (db) {
      await sql_create_table_1(db);
      await sql_create_table_2(db);
      await sql_create_table_3(db);
      await sql_create_table_4(db);
      await sql_create_table_5(db);

      console.log("Tables created");
    }

    return;
}

/******************************************************************************/

function sql_insert_workersample(db, expId, trycnt, bi, as, ae, ts, ta, oea, oer, d, ad, ai, ora, rtt, ortt) {
    db.run('INSERT INTO workersamples(experimentId, bi, asv, ae, ts, ta, oea, oer, d, ad, ai, ora, rtt, ortt) \
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?);', [expId, bi, as, ae, ts, ta, oea, oer, d, ad, ai, ora, rtt, ortt], function(err) {
      if (err) {
        mLog("Error inserting workersample" + err.message);
        //console.log("Error insertint workersample" + err.message);
        if (trycnt < 50) {
          sql_insert_workersample(db, expId, trycnt + 1, bi, as, ae, ts, ta, oea, oer, d, ad, ai, ora, rtt, ortt);
        } else {
          mLog("SQL is busy for more than 50 times. giving up for this sample.");
        }
        return;
      } else {
        return;
      }
    });
}

function sql_insert_summary(db, expId, columnNames, columnValues) {
    var q = "INSERT INTO measurementSummary(" + columnNames + ") VALUES(" + columnValues + ");";
    db.run(q, [], function(err) {
      if (err) {
        mLog("Error inserting workersample" + err.message);
        //console.log("Error insertint workersample" + err.message);
//        if (trycnt < 50) {
//          sql_insert_workersample(db, expId, trycnt + 1, bi, as, ae, ts, ta, oea, oer, d, ad, ai, ora, rtt, ortt);
//        } else {
//          mLog("SQL is busy for more than 50 times. giving up for this sample.");
//        }
        return;
      } else {
        return;
      }
    });
}

