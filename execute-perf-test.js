var request = require('request');
var debug = false;

var showUsage = function() {
  console.log('node execute-perf-test.js <cmd>');
  process.exit(1);
}

if (process.argv.length < 3) showUsage();


/*
 * Define common functions.
 */

var nifiApi = 'http://0.p.nifi.aws.mine:8080/nifi-api';
request = request.defaults({
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  }
});

var getProcessor = function(uuid, callback) {
  request(nifiApi + '/processors/' + uuid, (err, res, body) => {
    if (err) {
      callback(err);
      return;
    }
    if (res.statusCode == 200) {
      callback(null, JSON.parse(body));
    }
  });
}

var putProcessor = function(uuid, processor, callback) {
  if (debug) console.log('going to put', processor);
  request({
    url: nifiApi + '/processors/' + uuid,
    method: 'PUT',
    json: processor
  }, (err, res, body) => {
    if (err) {
      callback(err);
      return;
    }
    if(debug) console.log(res.statusCode);
    if (res.statusCode == 200) {
      callback(null);
      return;
    }
  });
}

var updateProcessorState = function(uuid, running, callback) {
  getProcessor(uuid, (err, processor) => {
    if (err) {
      callback(err);
      return;
    }
    putProcessor(uuid, {
      revision: processor.revision,
      component: {
        id: uuid,
        state: running ? "RUNNING" : "STOPPED"
      }
    }, (err) => {
      callback(err);
    })
  });
}

var updateProcessorConfig = function(uuid, updateConfig, callback) {
  getProcessor(uuid, (err, processor) => {
    if (err) {
      callback(err);
      return;
    }
    
    var c = processor.component;
    updateConfig(c.config);

    putProcessor(uuid, {
      revision: processor.revision,
      component: {
        id: c.id,
        name: c.name,
        config: c.config
      }
    }, (err) => {
      callback(err);
    })
  });
}

var getFlowStatus = function(callback) {
  request(nifiApi + '/flow/status', (err, res, body) => {
    if (err) {
      callback(err);
      return;
    }
    if (res.statusCode == 200) {
      callback(null, JSON.parse(body));
    }
  });
}

/*
 * Main logic.
 */

var generatorId = '4af8f124-0156-1000-0000-0000140a5b18';
var generatorConfig = {
  intervalSec: 1,
  batchSize: 100,
  fileSizeKb: 100
};
var cooldownSec = 10;
var queuedFlowFilesCheckIntervalSec = 10;
// Allow keeping up to average incoming flow-files per sec for 1 munite.
// If queued flow-file count exceeds this, test will terminate.
var flowFilesPerSec = Math.floor(generatorConfig.batchSize / generatorConfig.intervalSec);
var maxAllowedQueuedFlowFilesCount = flowFilesPerSec * 60;
var expectedThroughputKb = flowFilesPerSec * generatorConfig.fileSizeKb;
var start = new Date();
var testDurationSec = 60;

var queuedFlowFilesCheck = function() {
  getFlowStatus((err, flowStatus) => {
    if (err) {
      console.log('Failed to check flow status.', err);
      return;
    }

    if(debug) console.log(flowStatus);
    var queuedFlowFiles = flowStatus.controllerStatus.flowFilesQueued;
    if (queuedFlowFiles < maxAllowedQueuedFlowFilesCount) {

      // Check elapsed time.
      var now = new Date();
      var elapsedMillis = (now.getTime() - start.getTime());
      console.log(Math.floor(elapsedMillis / 1000) + ',' + queuedFlowFiles);

      if (elapsedMillis > testDurationSec * 1000) {
        console.log('Congratulations! The test have survived for ' + testDurationSec + ' sec. At expected throughput (kb/sec) :' + expectedThroughputKb);
        return;
      }

      setTimeout(queuedFlowFilesCheck, queuedFlowFilesCheckIntervalSec * 1000);
    } else {
      console.log('Too many queued flow-files. Terminate the test.');
      return;
    }
  });
}


console.log('Stopping generator.');
updateProcessorState(generatorId, false, (err) => {
  if (err) {
    console.log('Failed to stop the generator.', err);
    return;
  }

  getFlowStatus((err, flowStatus) => {
    if (err) {
      console.log('Failed to get flow status.', err);
      return;
    }
    var queuedFlowFiles = flowStatus.controllerStatus.flowFilesQueued;
    if (queuedFlowFiles > 0) {
      console.log('There are ' + queuedFlowFiles + ' flow-files remaining in NiFi queue. Cannot start test until it becomes empty.');
      return;
    }

    console.log('Updating generator config.', generatorConfig);
    console.log('maxAllowedQueuedFlowFilesCount', maxAllowedQueuedFlowFilesCount);
    updateProcessorConfig(generatorId, (config) => {
      config.schedulingPeriod = generatorConfig.intervalSec + 'sec';
      config.properties['Batch Size'] = generatorConfig.batchSize;
      config.properties['File Size'] = generatorConfig.fileSizeKb + 'kb';

    }, (err) => {
      if (err) {
        console.log('Failed to update the generator config.', err);
        return;
      }

      console.log('Waiting for ' + cooldownSec + ' sec to cooldown.');
      setTimeout(() => {
        console.log('Starting generator.');
        updateProcessorState(generatorId, true, (err) => {
          if (err) {
            console.log('Failed to start the generator.', err);
            return;
          }

          console.log('Checking how many flow-files are queued every ' + queuedFlowFilesCheckIntervalSec + ' sec..');
          queuedFlowFilesCheck();

        });
      }, cooldownSec * 1000);
    });
  });
});
