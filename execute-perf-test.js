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

var nifiApiP = 'http://0.p.nifi.aws.mine:8080/nifi-api';
var nifiApiQ = 'http://0.q.nifi.aws.mine:8080/nifi-api';
request = request.defaults({
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  }
});

var getProcessorIdByName = function(nifiApi, name, callback) {
  request(nifiApi + '/flow/search-results?q=' + name, (err, res, body) => {
    if (err) {
      callback(err);
      return;
    }
    if (res.statusCode == 200) {
      callback(null, JSON.parse(body).searchResultsDTO.processorResults[0].id);
    }
  });
}

var getProcessor = function(nifiApi, uuid, callback) {
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

var putProcessor = function(nifiApi, uuid, processor, callback) {
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

var updateProcessorState = function(nifiApi, uuid, running, callback) {
  getProcessor(nifiApi, uuid, (err, processor) => {
    if (err) {
      callback(err);
      return;
    }
    putProcessor(nifiApi, uuid, {
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

var updateProcessorConfig = function(nifiApi, uuid, updateConfig, callback) {
  getProcessor(nifiApi, uuid, (err, processor) => {
    if (err) {
      callback(err);
      return;
    }
    
    var c = processor.component;
    updateConfig(c.config);

    putProcessor(nifiApi, uuid, {
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

var getFlowStatus = function(nifiApi, callback) {
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

var execBasedOnQueuedFlowFileCount = function(nifiApi, maxAllowedQueued, callback) {
  getFlowStatus(nifiApi, (err, flowStatus) => {
    if (err) {
      if(debug) console.log('Failed to get flow status from ' + nifiApi, err);
      callback.onErr(err);
      return;
    }
    var queuedFlowFiles = flowStatus.controllerStatus.flowFilesQueued;
    if (queuedFlowFiles > maxAllowedQueued) {
      callback.onExceed(queuedFlowFiles);
      return;
    } else {
      callback.onLess(queuedFlowFiles);
      return;
    }
  });
}

/*
 * Main logic.
 */

var generatorConfig = {
  intervalSec: 1,
  batchSize: 100,
  fileSizeKb: 100
};
var cooldownSec = 10;
var queuedFlowFilesCheckIntervalSec = 10;
var flowFilesPerSec = Math.floor(generatorConfig.batchSize / generatorConfig.intervalSec);
var expectedThroughputKb = flowFilesPerSec * generatorConfig.fileSizeKb;
var start = new Date();
var testDurationSec = 60;
// Allow keeping up to average incoming flow-files per sec for the half of testDurationSec.
// If queued flow-file count exceeds this, test will terminate.
var maxAllowedQueuedFlowFilesCount = Math.floor(flowFilesPerSec * (testDurationSec / 2));

console.log('Stopping generator.');
getProcessorIdByName(nifiApiP, 'push-data-generator', (err, processorId) => {

  var generatorId = processorId;

  var queuedFlowFilesCheck = function() {

    var terminateTest = function() {
      console.log('Stopping generator.');
      updateProcessorState(nifiApiP, generatorId, false, (err) => {
        if (err) {
          console.log('Failed to stop the generator.', err);
          return;
        }
        console.log('Finished test.');
      });
    }

    execBasedOnQueuedFlowFileCount(nifiApiP, maxAllowedQueuedFlowFilesCount, {onErr: (err) => {
        console.log('Failed to get flow status from P.', err);

    }, onExceed: (countP) => {
        console.log('Too many queued flow-files (' + countP + ') in NiFi P. Terminate the test.');
        terminateTest();

    }, onLess: (countP) => {

      execBasedOnQueuedFlowFileCount(nifiApiQ, maxAllowedQueuedFlowFilesCount - countP, {onErr: (err) => {
          console.log('Failed to get flow status from Q.', err);

      }, onExceed: (countQ) => {
          console.log('Too many queued flow-files in NiFi P and Q (' + countP + ', ' + countQ + '). Terminate the test.');
          terminateTest();

      }, onLess: (count) => {
          // Check elapsed time.
          var now = new Date();
          var elapsedMillis = (now.getTime() - start.getTime());
          console.log(Math.floor(elapsedMillis / 1000) + ',' + count);
  
          if (elapsedMillis > testDurationSec * 1000) {
            console.log('Congratulations! The test have survived for ' + testDurationSec + ' sec. At expected throughput (kb/sec) :' + expectedThroughputKb);
            terminateTest();

          } else {
            setTimeout(queuedFlowFilesCheck, queuedFlowFilesCheckIntervalSec * 1000);
          }
      }});

    }});

  }


  updateProcessorState(nifiApiP, generatorId, false, (err) => {
    if (err) {
      console.log('Failed to stop the generator.', err);
      return;
    }

    execBasedOnQueuedFlowFileCount(nifiApiP, 0, {onErr: (err) => {
        console.log('Failed to get flow status from P.', err);

    }, onExceed: (count) => {
        console.log('There are ' + count + ' flow-files remaining in NiFi P queue. Cannot start test until it becomes empty.');

    }, onLess: (count) => {

      execBasedOnQueuedFlowFileCount(nifiApiQ, 0, {onErr: (err) => {
          console.log('Failed to get flow status from Q.', err);
  
      }, onExceed: (count) => {
          console.log('There are ' + count + ' flow-files remaining in NiFi Q queue. Cannot start test until it becomes empty.');
  
      }, onLess: (count) => {
        console.log('Updating generator config.', generatorConfig);
        console.log('maxAllowedQueuedFlowFilesCount', maxAllowedQueuedFlowFilesCount);
        updateProcessorConfig(nifiApiP, generatorId, (config) => {
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
            updateProcessorState(nifiApiP, generatorId, true, (err) => {
              if (err) {
                console.log('Failed to start the generator.', err);
                return;
              }
    
              console.log('Checking how many flow-files are queued every ' + queuedFlowFilesCheckIntervalSec + ' sec..');
              queuedFlowFilesCheck();
    
            });
          }, cooldownSec * 1000);
        });
      }});  
    }});  
  });
});

