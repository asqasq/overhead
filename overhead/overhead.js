/**
 * This is a test program for computing the runtime overhead of OpenWhisk actions and rules. It executes
 * a set of either action or rule invocations, and measures the following:
 * - [BI] timestamp before the invocation (that is, before the action is invoked or before the trigger of the rule is fired)
 * - [TS] timestamp of the trigger start for rule invocation - from the trigger activation. It is NaN for action invocations.
 * - [AS] timestamp of the action start (if rule - of the bound action's start) - from the action activation
 * - [AE] timestamp of the action end - from the activation
 * - [D] duration of the 'net' action execution - as reported by the action itself
 * Based on these data the following results can be computed:
 * AS - BI = [OEA] overhead of entering the action
 * AE - BI - D = [OER] overhead of entering the action and returning the result to the invoker
 * AE - AS = [AD] action duration as measured by OW. Sanity: should always maintain AD > D.
 * AS - TS = [TA] time from trigger to action. 
 * 
 * These are the longest overheads that are common to action and rule and are visible externally and can thus be compared.
 * There might be additional overheads of log collection and writing activation, but those are not visible without more 
 * tooling such as Kamino+Prometheus. Note that for actions there is the overhead of returning the result, but that is not 
 * comparable with rules.
 * 
 * This program also computes throughput, as following: each worker, and the master, keeps track of the following details: 
 * total number of actions, total number of activations, total number of controller requests, earliest BI (of first invocation), and latest AE
 * (of the last-ending invocation). Computing the latest AE parameter for each worker requires post-processing, since the workers 
 * invoke asynchronously and do not retrieve the activations during load.
 * Based on the above data, throughput can be computed by dividing the sum of counters for all workers by the period from {min earliest BI} to
 * {max latest AE}. Computation is twice: once with master data and once without, to measure the interference
 * of the measurements of the master on the overall load. The final throughput values are: actions.{tp, tpw}, activations.{tp, tpw}, requests{.tp, tpw}.
 * ".tp" means total throughput including the master, and= ".tpw" means workers only.
 * 
 * Important note: OpenWhisk is a distributed system, which means that clock skew is expected between the client machine running the overhead
 * test and the controllers that generate the timestamps in the activation records. However, this implemenation assumes that clock skew is bound at few msec
 * range, due to having all machines synchronized, typically using NTP. At such a scale, clock skew is negligible compared to the measured times, and 
 * is therefore not addressed. When it comes to time differences inside an activation (which could be very small), they are generated by the clock of
 * the same controller and are therefore synchronized.
 *  
 * Setup:
 * ------
 * 1. Create test action - wsk action create testAction test.js
 * 2. Create test trigger - wsk trigger create testTrigger
 * 3. Create K test rules - wsk rule create testRule_i testTrigger testAction
 * The testAction receives parameters but doesn't use them. It sleeps for period of time that is specified in a parameter (e.g. 500 msec) and then 
 * returns the actual time passed from before the sleep to after. 
 * 
 * There are two main use-cases for measurement that this tool handles:
 * 1. Measuring throughput and latency of rules or of actions at a given configuration. In this mode, the tool spins up a number of workers, all
 * invoking rules (or all invoking actions) at a specified rate. Workers record BI and activation id for each invocation. When the measurement
 * ends, activations are retrieved and latencies are computed relative to the respective BIs as specified above.
 * 2. Comparing latencies of rule and action at a given configuration, under the same load. In this mode the tool runs a master and a number of
 * workers. The workers are responsible for stressing OW up to a point using a specific activity (rule or action) invoked at a specific rate.
 * The master also performs invocations, but of possibly a different activity and at a different rate, which is typically slow enough to avoid one
 * invocation interfere with the next one. This way, the same background load can be generated (using the same number of workers, same activity and
 * same worker invocation rate), for measuring action latency in one experiment, and then measuring rule latency in the next experiment, and consider 
 * these results comparable.
 *  
 * The program itself operates as following: A master process launches a specific number of worker processes (including itself).
 * - Each worker including the master starts issuing async invocations as specified by the input parameters: activity - trigger or <ratio> concurrent 
 * actions (<ratio> being the ratio of rules per trigger), parameter size, and delta between invocations. 
 * - At each invocation, each worker (incl the master) records the timestamp before the invocation, and the activation id[s] - either of the trigger,
 * or of the <ratio> actions.
 * - Once each worker has issued <warmup> invocations, it notifies the master with INIT message. Once the master receives INIT message from all workers 
 * and has issued <warmup> invocations itself, it marks the beginning of the measurement. 
 * - The end of the measurement is determined either by the master completing <count> invocations, or by the master having worked for <period> msec. 
 * - At the end, the master marks the end of the measurement, aborts the invocation loop and sends ABORT to all other workers, with the marked 
 * timestamps of start and finish of the measurement. Then the master proceeds to post-processing. 
 * - Every worker, when receiving ABORT, aborts the invocation loop and proceeds to post-processing. 
 * - During post-processing, each worker (incl. the master) is assumed to have a sequence of sample records, each with BI marking the timestamp
 * before the invocation, and the relevant activation ids. Thus, for each rule invocation there is one sample with activation id of the trigger. For
 * action invocation, there are <ratio> samples, each with the activation id of the invoked action (but all with the same BI). 
 * - Based on the BI, TS, AS and AE (from the activation), each sample is checked agained the measurement time-frame.
 * - Matching samples (or contained activations) are considered for latency and throughput computation, and update the counter records defined in the code.
 * - Once all samples are processed, each worker sends a SUMMARY message to the master with the counter records and exits.
 * - Once the master receives a SUMMARY message from each worker, as well as completes its own post-processing, it generates the output record based
 * either on merged counter data (UC #1) or partially merged - if master values were set apart (UC #2).   
 * 
  * Input:
 * ------
 * This overhead test program takes 7 parameters: 
 * 1. Flag a/r/n which selects what to measure - (a)ction or (r)rule or (n)one. If none, see below comments.
 * 2. Number of measurement invocations or [for none] the period of measurement in msec  
 * 3. Trigger-to-action ratio at each measurement. Either triggered by a single rule invocation (which, by setup above, triggers K actions) or explicitly as concurrent K action invocations.
 * 4. Size of input parameter string. Although the parameter is not used, it causes marshalling/unmarshalling which 
 * 5. Number of concurrent workers
 * 6. Flag a/r which selects how workers generate load - action or rule 
 * 7. Delta - period between the starts of two consequent invocations of the same worker
 * Comments:
 * - "none" mode is used for measuring only throughput, generated by workers. In this mode, the master does not perform any measurements. 
 * - Workers use the same parameter size as master.
 *  
 * Output:
 * -------
 * The output of the program is a single CSV row of data consisting of the input parameters, 
 * then latencies computed above - avg (average) and std (std. dev.), then throughput.
 * The resulting CSV is printed to standard output and can be redirected to a file as needed. 
 * Every other output is printed to stderr and can be silenced if needed.
 */

const fs = require('fs');
const ini = require('ini');
const cluster = require('cluster');
const openwhisk = require('openwhisk');
const program = require('commander');

const ACTION = "action";
const RULE = "rule";

function parseIntDef(strval, defval) {
	return parseInt(strval);
}

program
	.description('Latency and throughput measurement of OpenWhisk actions and rules')
	.version('0.0.1')
	.option('-a, --activity <action/rule>', "Activity to measure", /^(action|rule)$/i, "action")
	.option('-i, --iterations <count>', "Number of measurement iterations", parseInt)
	.option('-p, --period <msec>', "Period of measurement in msec", parseInt)
	.option('-r, --ratio <count>', "How many actions per iteration (or rules per trigger)", parseIntDef, 1)
	.option('-s, --parameter_size <size>', "Size of string parameter passed to trigger or actions", parseIntDef, 1000)
	.option('-w, --workers <count>', "Total number of concurrent workers incl. master", parseIntDef, 1)
	.option('-d, --delta <msec>', "Time diff between consequent invocations of the same worker, in msec", parseIntDef, 200)
	.option('-A, --master_activity <action/rule>', "Set master activity apart from other workerss", /^(action|rule)$/i)   
	.option('-D, --master_delta <msec>', "Set master delta apart from other workers", parseInt)
	.option('-u, --warmup <count>', "How many invocations to perform at each worker as warmup", parseIntDef, 5)
	.option('-l, --delay <msec>', "How many msec to delay at each action", parseIntDef, 50)
	.option('-t --activationdelay <msec>', "Wait for activations to show before post-processing", parseIntDef, 60000)
	.option('-q, --quiet', "Suppress progress information on stderr");

program.parse(process.argv);

var testRecord = {input: {}, output: {}};	// holds the final test data

for (var opt in program.opts())
	if (typeof program[opt] != 'function') 
		testRecord.input[opt] = program[opt];

// If neither period nor iterations are set, then period is set by default to 1000 msec
if (!testRecord.input.iterations && !testRecord.input.period)
	testRecord.input.period = 1000;

// If either master_activity or master_delta are set, then test is in 'master apart' mode (UC #2), else UC #1
testRecord.input.master_apart = ((testRecord.input.master_activity || testRecord.input.master_delta) && true);

mLog("Parameter Configuration:");
for (var opt in testRecord.input)
	mLog(`${opt} = ${testRecord.input[opt]}`);
mLog("-----\n");

mLog("Generating invocation parameters");
var inputMessage = "A".repeat(testRecord.input.parameter_size);
var params = {sleep: testRecord.input.delay, message: inputMessage};

mLog("Loading wskprops");
var config = ini.parse(fs.readFileSync("/home/vagrant/.wskprops", "utf-8"));
mLog("APIHOST = " + config.APIHOST);
mLog("AUTH = " + config.AUTH);
mLog("-----\n");

// openwhisk client used for invocations
const ow = openwhisk({apihost: config.APIHOST, api_key: config.AUTH, ignore_certs: true});
 
// counters for throughput computation (all)
const tpCounters = {attempts: 0, invocations: 0, activations: 0, requests: 0, errors: 0};	

// counters for latency computation
const latCounters = {
					ta: {sum: 0, sumSqr: 0, min: undefined, max: undefined}, 
					oea: {sum: 0, sumSqr: 0, min: undefined, max: undefined}, 
					oer: {sum: 0, sumSqr: 0, min: undefined, max: undefined}, 
					d: {sum: 0, sumSqr: 0, min: undefined, max: undefined}, 
					ad: {sum: 0, sumSqr: 0, min: undefined, max: undefined}
};

const measurementTime = {start: -1, stop: -1};

const sampleData = [];	// array of samples (tuples of collected invocation data, for rule or for action, depending on the activity)

var loopSleeper;	// used to abort sleep in mainLoop()
var abort = false;	// used to abort the loop in mainLoop()

// Used only at the master
var workerData = [];	// holds data for each worker, at [1..#workers]. Master's entry is 0.

const activity = ((cluster.isWorker || !testRecord.input.master_activity) ? testRecord.input.activity : testRecord.input.master_activity);

if (cluster.isMaster) 
	runMaster();
else
	runWorker();

// -------- END OF MAIN -------------

/**
 * Master operation
 */
function runMaster() {

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
		testRecord.output.measureTime = (measurementTime.stop - measurementTime.start) / 1000.0;	// measurement duration converted to seconds
		mLog(`Stop measurement. Start post-processing after ${testRecord.input.activationdelay} msec`);
		mLog("id,\tbi,\tas,\tae,\tts,\tta,\toea,\toer,\td,\tad");
		for (const j in cluster.workers) 
			cluster.workers[j].send({abort: measurementTime});

		// The master's post-processing to generate its workerData
		sleep(testRecord.input.activationdelay)
			.then(() => {
				postProcess()
				.then(() => {
					// The master's workerData
					workerData[0] = {lat: latCounters, tp: tpCounters};
					checkSummary();
				})
				.catch(err => {	// shouldn't happen unless BUG
					mLog(`Post-process ERROR in MASTER: ${err}`);
					throw err;
				});
			});
	});
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
		sleep(testRecord.input.activationdelay)
			.then(() => {
				postProcess()
					.then(() => {
						process.send({summary:{lat: latCounters, tp:tpCounters}});
						process.exit();
					})
					.catch(err => {	// shouldn't happen unless BUG
						mLog(`Post-process ERROR in WORKER: ${err}`);
						throw err;
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
		mLog("All workers engaged. Start measurement.");
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
		mLog("Done");
		process.exit();
	}
}

// Barrier for receiving post-processing results from all workers before computing final results

var remainingSummaries = testRecord.input.workers;

function checkSummary() {
	remainingSummaries--;
	if (remainingSummaries == 0) {
		mLog("id,\tbi,\tas,\tae,\tts,\tta,\toea,\toer,\td,\tad");
		mLog("-----------------");
		mLog("All workers post-processing completed - computing output.")
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

		const bi = new Date().getTime();

		var samples;

		if (activity == ACTION) 
			samples = await invokeActions(testRecord.input.ratio);
		else 
			samples = await invokeRules();

		samples.forEach(sample => {
			sample.bi = bi;
			sampleData.push(sample);
		});

		const ai = new Date().getTime();
		const duration = ai - bi;
		if (delta > duration) {
			loopSleeper = sleep(delta - duration);
			if (!abort)		// check again to avoid race condition on loadSleeper
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
 * Invoke the predefined OW action a specified number of times. All invocations are asynchronous, but keep the activation ids.
 * Returns a promise that resolves to an array of {id, isError}.
 */
function invokeActions(count) {
	return new Promise( function (resolve, reject) {
		var ipa = [];	// array of invocation promises;
		for(var i = 0; i< count; i++) {
			ipa[i] = new Promise((resolve, reject) => {
				ow.actions.invoke({name: 'testAction', params: params})
					.then(activationIdJSON => {resolve({aaid: activationIdJSON.activationId})})
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
function invokeRules() {
	return new Promise( function (resolve, reject) {
		const triggerSamples = [];
		// Fire trigger to invoke the rule
		ow.triggers.invoke({name: 'testTrigger', params: params})
			.then(triggerActivationIdJSON => {
				const triggerActivationId = triggerActivationIdJSON.activationId;
				triggerSamples.push({taid: triggerActivationId});
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
 * 1. If the activation has error (isError == true) -> only update request counter, then discard.
 * 2. Retrieve the activation. If retrieval fails, abort (fatal error).
 * 3. If activity is rule, extract trigger start and retrieve the activation ids of the bound actions, then retrieve the activations. 
 * If activation retrieval fails, abort
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
		try {
			actionSample.activation = await ow.activations.get({name: actionSample.aaid});
		}
		catch (err) {
			mLog(`Failed to retrieve activation for id: ${actionSample.aaid} for reason: ${err}`);
		}
		processSample(actionSample);
	}
}


/**
 * Process a single sample, updating latency and throughput counters
 * @param {*} sample
 */
function processSample(sample) {

	const samplerId = (cluster.isMaster ? "MASTER-0" : `WORKER-${cluster.worker.id}`);
	const bi = sample.bi;

	if (bi < measurementTime.start || bi > measurementTime.stop)	{	// BI outside time frame. No further processing.
		mLog(`${samplerId}: Sample discarded. BI exceeds measurement time frame`);
		return;
	}

	tpCounters.attempts++;	// each sample invoked in the time frame counts as one invocation attempt

	if (sample.taidError) {	// trigger activation failed - count one request, one error. No further processing.
		tpCounters.requests++;
		tpCounters.errors++;
		mLog(`${samplerId}: Sample discarded. Trigger activation error: ${sample.taidError}`);
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
		ts = NaN;

	if (sample.aaidError) {	// action activation failed - count one request, one error. No further processing.
		tpCounters.requests++;
		tpCounters.errors++;
		mLog(`${samplerId}: Sample discarded. Action activation error: ${sample.aaidError}`);
		return;
	}

	if (!sample.activation) {	// no activation, so assumed incomplete. No further processing.
		mLog(`${samplerId}: Sample discarded. Activation was not retrieved.`)
		return;
	}

	const as = parseInt(sample.activation.start);
	const ae = parseInt(sample.activation.end);
	const d = parseInt(sample.activation.response.result.slept);

	if (as < measurementTime.start || ae > measurementTime.stop) {	// got activation, but it exceeds the time frame. No further processing.
		mLog(`${samplerId}: Sample discarded. Action activation exceeded measurement time frame.`)
		return;
	}

	// Activation is in time frame, so count one activation, one request
	tpCounters.activations++;
	tpCounters.requests++;

	// everything inside time frame - count invocation and update latency counters
	tpCounters.invocations++;	

	const ta = as - ts;
	const ad = ae - as;
	const oea = as - bi;
	const oer = ae - bi - d;

	updateLatSample("d", d);
	updateLatSample("ta", ta);
	updateLatSample("ad", ad);
	updateLatSample("oea", oea);
	updateLatSample("oer", oer);

	mLog(`${samplerId},\t${bi},\t${as},\t${ae},\t${ts},\t${ta},\t${oea},\t${oer},\t${d},\t${ad}`);
}

/**
 * Update counters of one latency statistic of a worker with data from one sample
 */
function updateLatSample(statName, value) {

	latCounters[statName].sum += value;
	latCounters[statName].sumSqr += value * value;
	if (!latCounters[statName].min || latCounters[statName].min > value)
		latCounters[statName].min = value;
	if (!latCounters[statName].max || latCounters[statName].max < value)
		latCounters[statName].max = value;
}


/**
 * Compute the final output record based on the workerData records.
 * The output of the program is a single CSV row of data consisting of the input parameters, 
 * then latencies computed above - avg (average) and std (std. dev.), then throughput.
 */
function computeOutputRecord() {

	// Latency stats: avg + std
	["ta", "oea", "oer", "d", "ad"].forEach(statName => {
		testRecord.output[statName] = computeLatStats(statName);
	});

	// Tp stats: tp + tpw
	["attempts", "invocations", "activations", "requests"].forEach(statName => {
		testRecord.output[statName] = computeTpStats(statName);
	});

	// Error stats: percentage
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
	var min = undefined;
	var max = undefined;
	if (testRecord.input.master_apart) {	// in UC #2, only master performs latency measurements
		totalSum = workerData[0].lat[statName].sum;
		totalSumSqr = workerData[0].lat[statName].sumSqr;
		min = workerData[0].lat[statName].min;
		max = workerData[0].lat[statName].max;
		totalInvocations = workerData[0].tp.invocations;
	}
	else // in UC #1, all workers participate in latency measurements
		workerData.forEach(wd => { 
			totalSum += wd.lat[statName].sum;
			totalSumSqr += wd.lat[statName].sumSqr;
			if (!min || min > wd.lat[statName].min)
				min = wd.lat[statName].min;
			if (!max || max < wd.lat[statName].max)
				max = wd.lat[statName].max;
			totalInvocations += wd.tp.invocations;
		});

	const avg = totalSum / totalInvocations;
	const std = Math.sqrt(totalSumSqr / totalInvocations - avg * avg);

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
	const tp = totalCount / testRecord.output.measureTime;			// throughput
	const tpw = (totalCount - masterCount) / testRecord.output.measureTime;		// throughput without master
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
		console.error(text);
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