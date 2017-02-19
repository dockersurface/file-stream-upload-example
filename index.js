'use strict';

let request = require('request');
let fs = require('fs');
let uuid = require('node-uuid');
let Promise = require('bluebird');

// 引入缓存模块
let BufferCache = require('./bufferCache');
const chunkSplice = 2097152; // 2MB
const RETRY_COUNT = 3;
let bufferCache = new BufferCache(chunkSplice);

let isFinished = false;

function getChunks(url, onStartDownload, onDownloading, onDownloadClose) {
    'use strict';

    let totalLength = 0;

    let httpStream = request({
        method: 'GET',
        url: url
    });
    // 由于不需要获取最终的文件，所以直接丢掉
    let writeStream = fs.createWriteStream('/dev/null');

    // 联接Readable和Writable
    httpStream.pipe(writeStream);

    httpStream.on('response', (response) => {
        onStartDownload(response.headers);
    }).on('data', (chunk) => {
        totalLength += chunk.length;
        onDownloading(chunk, totalLength);
    });

    writeStream.on('close', () => {
        onDownloadClose(totalLength);
    });
}

function upload(url, data) {
    return new Promise((resolve, reject) => {
        request.post({
            url: url,
            formData: data
        }, function (err, response, body) {
            if (!err && response.statusCode === 200) {
                resolve(body);
            }
            else {
                reject(err);
            }
        });
    });
}


function sendChunks() {
    let chunkId = 0;
    let isSending = false;
    let stopSend = false;

    function send(options) {
        let readyCache = options.readyCache;
        let fresh = options.fresh;
        let retryCount = options.retry;
        let chunkIndex;

        let chunk = null;

        if (fresh) {
            if (readyCache.length === 0) {
                return Promise.resolve();
            }

            chunk = readyCache.shift();
            chunkIndex = chunkId;
            chunkId++;
        }
        else {
            chunk = options.data;
            chunkIndex = options.index;
        }

        isSending = true;

        console.log('sending size', chunk.length);

        return upload('http://localhost:3000', {
            chunk: {
                value: chunk,
                options: {
                    filename: 'example.mp4_IDSPLIT_' + chunkIndex
                }
            }
        }).then((response) => {
            isSending = false;
            let json = JSON.parse(response);

            if (json.errno === 0 && readyCache.length > 0) {
                return send({
                    retry: RETRY_COUNT,
                    fresh: true,
                    readyCache: readyCache
                });
            }

            return Promise.resolve(json);
        }).catch(err => {
            console.log(err);
            if (retryCount > 0) {
                sendPList.pop();
                return send({
                    retry: retryCount - 1,
                    index: chunkId,
                    fresh: false,
                    data: chunk,
                    readyCache: readyCache
                });
            }
            else {
                console.log(`upload failed of chunkIndex: ${chunkId}`);
                stopSend = true;
                return Promise.reject(err);
            }
        });
    }

    return new Promise((resolve, reject) => {
        let readyCache = bufferCache.getChunks();
        let threadPool = [];

        let sendTimer = setInterval(() => {
            if (!isSending) {
                if (readyCache.length > 0) {
                    for (let i = 0; i < 4; i++) {
                        let thread = send({
                            retry: RETRY_COUNT,
                            fresh: true,
                            readyCache: readyCache
                        });

                        threadPool.push(thread);
                    }
                }
                else if (isFinished) {
                    console.log('got last chunk');
                    let lastChunk = bufferCache.getRemainChunks();
                    readyCache.push(lastChunk);
                }
            }

            if ((isFinished && readyCache.length === 0) || stopSend) {
                console.log('run clear');
                clearTimeout(sendTimer);

                Promise.all(threadPool).then(() => {
                    console.log('send success');
                }).catch(err => {
                    console.log('send failed');
                });
            }

            // not ready, wait for next interval
        }, 200);
    });
}

function onStart(headers) {
    // console.log('start downloading, headers is :', headers);

    sendChunks();
}

function onData(chunk, downloadedLength) {
    // console.log('write ' + chunk.length + 'KB into cache');
    // 都写入缓存中 
    bufferCache.pushBuf(chunk);
}

function onFinished(totalLength) {
    let chunkCount = Math.ceil(totalLength / chunkSplice);
    console.log('total chunk count is:' + chunkCount);
    isFinished = true;
}

getChunks('https://baobao-3d.bj.bcebos.com/16-0-205.shuimian.mp4', onStart, onData, onFinished);