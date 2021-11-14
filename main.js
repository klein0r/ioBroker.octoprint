/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const adapterName = require('./package.json').name.split('.').pop();

class OctoPrint extends utils.Adapter {

    constructor(options) {
        super({
            ...options,
            name: adapterName,
        });

        this.supportedVersion = '1.7.2';
        this.apiConnected = false;
        this.printerStatus = 'API not connected';
        this.systemCommands = [];

        this.refreshStateTimeout = null;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        this.subscribeStates('*');
        this.setPrinterState(false);

        if (!this.config.octoprintApiKey) {
            this.log.warn('API key not configured. Check configuration of instance ' + this.namespace);
        }

        if (this.config.customName) {
            this.setStateAsync('name', this.config.customName, true);
        }

        this.log.debug('Starting with API refresh interval: ' + this.config.apiRefreshInterval + ' (' + this.config.apiRefreshIntervalPrinting + ' while printing)');

        // Delete old (unused) namespace on startup
        await this.delObjectAsync('temperature', {recursive: true});

        this.refreshState('onReady', true);
    }

    onUnload(callback) {
        try {
            this.setPrinterState(false);

            if (this.refreshStateTimeout) {
                this.log.debug('clearing refresh state timeout');
                clearTimeout(this.refreshStateTimeout);
            }

            this.log.debug('cleaned everything up...');
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if (state && !state.ack) {
            const cleanId = this.removeNamespace(id);

            // No ack = changed by user
            if (this.apiConnected) {
                if (id.match(new RegExp(this.namespace + '.tools.tool[0-9]{1}.(targetTemperature|extrude)'))) {

                    const matches = id.match(/.+\.tools\.(tool[0-9]{1})\.(targetTemperature|extrude)$/);
                    const toolId = matches[1];
                    const command = matches[2];

                    if (command === 'targetTemperature') {
                        this.log.debug('changing target "' + toolId + '" temperature to ' + state.val);

                        let targetObj = {};
                        targetObj[toolId] = state.val;

                        this.buildRequest(
                            'printer/tool',
                            (content, status) => {
                                if (status == 204) {
                                    this.setStateAsync(cleanId, state.val, true);
                                } else {
                                    // 400 Bad Request – If targets or offsets contains a property or tool contains a value not matching the format tool{n}, the target/offset temperature, extrusion amount or flow rate factor is not a valid number or outside of the supported range, or if the request is otherwise invalid.
                                    // 409 Conflict – If the printer is not operational or – in case of select or extrude – currently printing.

                                    this.log.error(content);
                                }
                            },
                            {
                                command: 'target',
                                targets: targetObj
                            }
                        );
                    } else if (command === 'extrude') {
                        this.log.debug('extruding ' + state.val + 'mm');

                        this.buildRequest(
                            'printer/tool',
                            (content, status) => {
                                if (status == 204) {
                                    this.setStateAsync(cleanId, state.val, true);
                                } else {
                                    // 400 Bad Request – If targets or offsets contains a property or tool contains a value not matching the format tool{n}, the target/offset temperature, extrusion amount or flow rate factor is not a valid number or outside of the supported range, or if the request is otherwise invalid.
                                    // 409 Conflict – If the printer is not operational or – in case of select or extrude – currently printing.

                                    this.log.error(content);
                                }
                            },
                            {
                                command: 'extrude',
                                amount: state.val
                            }
                        );
                    }

                } else if (id === this.namespace + '.tools.bed.targetTemperature') {

                    this.log.debug('changing target bed temperature to ' + state.val);

                    this.buildRequest(
                        'printer/bed',
                        (content, status) => {
                            if (status == 204) {
                                this.setStateAsync(cleanId, state.val, true);
                            } else {
                                // 400 Bad Request – If target or offset is not a valid number or outside of the supported range, or if the request is otherwise invalid.
                                // 409 Conflict – If the printer is not operational or the selected printer profile does not have a heated bed.

                                this.log.error(content);
                            }
                        },
                        {
                            command: 'target',
                            target: state.val
                        }
                    );

                } else if (id === this.namespace + '.command.printer') {

                    const allowedCommandsConnection = ['connect', 'disconnect', 'fake_ack'];
                    const allowedCommandsPrinter = ['home'];

                    if (allowedCommandsConnection.indexOf(state.val) > -1) {
                        this.log.debug('sending printer connection command: ' + state.val);

                        this.buildRequest(
                            'connection',
                            (content, status) => {
                                if (status == 204) {
                                    this.setStateAsync(cleanId, state.val, true);
                                    this.refreshState('onStateChange command.printer', false);
                                } else {
                                    // 400 Bad Request – If the selected port or baudrate for a connect command are not part of the available options.

                                    this.log.error(content);
                                }
                            },
                            {
                                command: state.val
                            }
                        );
                    } else if (allowedCommandsPrinter.indexOf(state.val) > -1) {

                        this.log.debug('sending printer command: ' + state.val);

                        this.buildRequest(
                            'printer/printhead',
                            (content, status) => {
                                if (status == 204) {
                                    this.setStateAsync(cleanId, state.val, true);
                                } else {
                                    // 400 Bad Request – Invalid axis specified, invalid value for travel amount for a jog command or factor for feed rate or otherwise invalid request.
                                    // 409 Conflict – If the printer is not operational or currently printing.

                                    this.log.error(content);
                                }
                            },
                            {
                                command: state.val,
                                axes: ['x', 'y', 'z']
                            }
                        );
                    } else {
                        this.log.error('printer command not allowed: ' + state.val + '. Choose one of: ' + allowedCommandsConnection.concat(allowedCommandsPrinter).join(', '));
                    }

                } else if (id === this.namespace + '.command.printjob') {

                    const allowedCommands = ['start', 'cancel', 'restart'];

                    if (allowedCommands.indexOf(state.val) > -1) {
                        this.log.debug('sending printjob command: ' + state.val);

                        this.buildRequest(
                            'job',
                            (content, status) => {
                                if (status == 204) {
                                    this.setStateAsync(cleanId, state.val, true);
                                } else {
                                    // 409 Conflict – If the printer is not operational or the current print job state does not match the preconditions for the command.

                                    this.log.error(content);
                                }
                            },
                            {
                                command: state.val
                            }
                        );
                    } else {
                        this.log.error('print job command not allowed: ' + state.val + '. Choose one of: ' + allowedCommands.join(', '));
                    }

                } else if (id === this.namespace + '.command.sd') {

                    const allowedCommands = ['init', 'refresh', 'release'];

                    if (allowedCommands.indexOf(state.val) > -1) {
                        this.log.debug('sending sd card command: ' + state.val);

                        this.buildRequest(
                            'printer/sd',
                            (content, status) => {
                                if (status == 204) {
                                    this.setStateAsync(cleanId, state.val, true);
                                } else {
                                    // 409 Conflict – If a refresh or release command is issued but the SD card has not been initialized (e.g. via init).

                                    this.log.error(content);
                                }
                            },
                            {
                                command: state.val
                            }
                        );
                    } else {
                        this.log.error('sd card command not allowed: ' + state.val + '. Choose one of: ' + allowedCommands.join(', '));
                    }

                } else if (id === this.namespace + '.command.custom') {

                    this.log.debug('sending custom command: ' + state.val);

                    this.buildRequest(
                        'printer/command',
                        (content, status) => {
                            if (status == 204) {
                                this.setStateAsync(cleanId, state.val, true);
                            } else {
                                this.log.error(content);
                            }
                        },
                        {
                            command: state.val
                        }
                    );

                } else if (id === this.namespace + '.command.system') {

                    if (this.systemCommands.indexOf(state.val) > -1) {
                        this.log.debug('sending system command: ' + state.val);

                        this.buildRequest(
                            'system/commands/' + state.val,
                            (content, status) => {
                                if (status == 204) {
                                    this.setStateAsync(cleanId, state.val, true);
                                } else {
                                    // 400 Bad Request – If a divider is supposed to be executed or if the request is malformed otherwise
                                    // 404 Not Found – If the command could not be found for source and action
                                    // 500 Internal Server Error – If the command didn’t define a command to execute, the command returned a non-zero return code and ignore was not true or some other internal server error occurred

                                    this.log.error(content);
                                }
                            },
                            {}
                        );
                    } else {
                        this.log.error('system command not allowed: ' + state.val + '. Choose one of: ' + this.systemCommands.join(', '));
                    }
                } else if (id.indexOf(this.namespace + '.command.jog.') === 0) {

                    const axis = id.split('.').pop(); // Last element of the id is the axis
                    const jogCommand = {
                        command: 'jog',
                    };

                    // Add axis
                    jogCommand[axis] = state.val;

                    this.log.debug('sending jog ' + axis + ' command: ' + state.val);

                    this.buildRequest(
                        'printer/printhead',
                        (content, status) => {
                            if (status == 204) {
                                this.setStateAsync(cleanId, state.val, true);
                            } else {
                                // 400 Bad Request – Invalid axis specified, invalid value for travel amount for a jog command or factor for feed rate or otherwise invalid request.
                                // 409 Conflict – If the printer is not operational or currently printing.

                                this.log.error(content);
                            }
                        },
                        jogCommand
                    );
                } else if (id.match(new RegExp(this.namespace + '.files.[a-zA-Z0-9_]+.(select|print)'))) {
                    const matches = id.match(/.+\.files\.([a-zA-Z0-9_]+)\.(select|print)$/);
                    const fileId = matches[1];
                    const action = matches[2];

                    this.log.debug('selecting/printing file ' + fileId + ' - action: ' + action);

                    this.getState(
                        'files.' + fileId + '.path',
                        (err, state) => {
                            const fullPath = state.val;

                            this.log.debug('selecting/printing file with path ' + fullPath);

                            this.buildRequest(
                                'files/' + fullPath,
                                (content, status) => {
                                    if (status == 204) {
                                        this.log.debug('selection/print file successful');
                                        this.refreshState('onStateChange file.' + action, false);
                                    } else {
                                        this.log.error(content);
                                    }
                                },
                                {
                                    command: 'select',
                                    print: (action == 'print')
                                }
                            );
                        }
                    );
                }
            }
        }
    }

    setPrinterState(connection) {
        this.setStateAsync('info.connection', connection, true);
        this.apiConnected = connection;

        if (!connection) {
            this.printerStatus = 'API not connected';
            this.setStateAsync('printer_status', this.printerStatus, true);
        }
    }

    async refreshState(source, refreshFileList) {
        this.log.debug('refreshing state: started from ' + source);

        this.buildRequest(
            'version',
            (content, status) => {
                this.setPrinterState(true);

                this.log.debug('connected to OctoPrint API - online!');

                this.setStateAsync('meta.version', content.server, true);
                this.setStateAsync('meta.api_version', content.api, true);

                if (this.isNewerVersion(content.server, this.supportedVersion)) {
                    this.log.warn('You should update your OctoPrint installation - supported version of this adapter is ' + this.supportedVersion + ' (or later). Your current version is ' + content.server);
                }

                this.refreshStateDetails();

                if (refreshFileList) {
                    this.refreshFiles();
                } else {
                    this.log.debug('skipped file list refresh');
                }
            },
            null
        );

        if (!this.apiConnected) {
            this.log.debug('refreshing state: re-creating refresh timeout (API not connected)');
            this.refreshStateTimeout = this.refreshStateTimeout || setTimeout(() => {
                this.refreshStateTimeout = null;
                this.refreshState('timeout (API not connected)', true);
            }, 10 * 1000);
        } else if (this.printerStatus == 'Printing') {
            this.log.debug('refreshing state: re-creating refresh timeout (printing)');
            this.refreshStateTimeout = this.refreshStateTimeout || setTimeout(() => {
                this.refreshStateTimeout = null;
                this.refreshState('timeout (printing)', false);
            }, this.config.apiRefreshIntervalPrinting * 1000); // Default 10 sec
        } else if (this.printerStatus == 'Operational') {
            this.log.debug('refreshing state: re-creating refresh timeout (operational)');
            this.refreshStateTimeout = this.refreshStateTimeout || setTimeout(() => {
                this.refreshStateTimeout = null;
                this.refreshState('timeout (operational)', true);
            }, this.config.apiRefreshIntervalOperational * 1000); // Default 30 sec
        } else {
            this.log.debug('refreshing state: re-creating state timeout (default)');
            this.refreshStateTimeout = this.refreshStateTimeout || setTimeout(() => {
                this.refreshStateTimeout = null;
                this.refreshState('timeout (default)', true);
            }, this.config.apiRefreshInterval * 1000); // Default 60 sec
        }
    }

    async refreshStateDetails() {
        if (this.apiConnected) {
            this.buildRequest(
                'connection',
                (content, status) => {
                    this.printerStatus = content.current.state;
                    this.setStateAsync('printer_status', this.printerStatus, true);
                },
                null
            );

            this.buildRequest(
                'printer',
                async (content, status) => {
                    if (typeof content === 'object' && Object.prototype.hasOwnProperty.call(content, 'temperature')) {
                        for (const key of Object.keys(content.temperature)) {
                            const obj = content.temperature[key];

                            const isTool = key.indexOf('tool') > -1;
                            const isBed = key == 'bed';

                            if (isTool || isBed) { // Tool + bed information

                                // Create tool channel
                                await this.setObjectNotExistsAsync('tools.' + key, {
                                    type: 'channel',
                                    common: {
                                        name: key,
                                    },
                                    native: {}
                                });

                                // Set actual temperature
                                await this.setObjectNotExistsAsync('tools.' + key + '.actualTemperature', {
                                    type: 'state',
                                    common: {
                                        name: 'Actual temperature',
                                        type: 'number',
                                        role: 'value.temperature',
                                        unit: '°C',
                                        read: true,
                                        write: false
                                    },
                                    native: {}
                                });
                                await this.setStateAsync('tools.' + key + '.actualTemperature', obj.actual, true);

                                // Set target temperature
                                await this.setObjectNotExistsAsync('tools.' + key + '.targetTemperature', {
                                    type: 'state',
                                    common: {
                                        name: 'Target temperature',
                                        type: 'number',
                                        role: 'value.temperature',
                                        unit: '°C',
                                        read: true,
                                        write: true
                                    },
                                    native: {}
                                });
                                await this.setStateAsync('tools.' + key + '.targetTemperature', obj.target, true);

                                // Set offset temperature
                                await this.setObjectNotExistsAsync('tools.' + key + '.offsetTemperature', {
                                    type: 'state',
                                    common: {
                                        name: 'Offset temperature',
                                        type: 'number',
                                        role: 'value.temperature',
                                        unit: '°C',
                                        read: true,
                                        write: false
                                    },
                                    native: {}
                                });
                                await this.setStateAsync('tools.' + key + '.offsetTemperature', obj.target, true);
                            }

                            if (isTool) {
                                // Set extrude
                                await this.setObjectNotExistsAsync('tools.' + key + '.extrude', {
                                    type: 'state',
                                    common: {
                                        name: 'Extrude',
                                        type: 'number',
                                        role: 'value',
                                        unit: 'mm',
                                        read: true,
                                        write: true
                                    },
                                    native: {}
                                });
                            }
                        }
                    }
                },
                null
            );

            this.buildRequest(
                'system/commands',
                (content, status) => {
                    this.systemCommands = [];

                    for (const key of Object.keys(content)) {
                        const arr = content[key];
                        arr.forEach(e => this.systemCommands.push(e.source + '/' + e.action));
                    }

                    this.log.debug('Registered system commands: ' + this.systemCommands.join(', '));
                },
                null
            );

            this.buildRequest(
                'job',
                (content, status) => {
                    if (Object.prototype.hasOwnProperty.call(content, 'job') && Object.prototype.hasOwnProperty.call(content.job, 'file')) {
                        this.setStateAsync('printjob.file.name', content.job.file.name, true);
                        this.setStateAsync('printjob.file.origin', content.job.file.origin, true);
                        this.setStateAsync('printjob.file.size', Number((content.job.file.size / 1024).toFixed(2)), true);
                        this.setStateAsync('printjob.file.date', new Date(content.job.file.date * 1000).getTime(), true);

                        if (Object.prototype.hasOwnProperty.call(content.job, 'filament') && content.job.filament) {
                            let filamentLength = 0;
                            let filamentVolume = 0;

                            if (Object.prototype.hasOwnProperty.call(content.job.filament, 'tool0') && content.job.filament.tool0) {
                                filamentLength = Object.prototype.hasOwnProperty.call(content.job.filament.tool0, 'length') ? content.job.filament.tool0.length : 0;
                                filamentVolume = Object.prototype.hasOwnProperty.call(content.job.filament.tool0, 'volume') ? content.job.filament.tool0.volume : 0;
                            } else {
                                filamentLength = Object.prototype.hasOwnProperty.call(content.job.filament, 'length') ? content.job.filament.length : 0;
                                filamentVolume = Object.prototype.hasOwnProperty.call(content.job.filament, 'volume') ? content.job.filament.volume : 0 ;
                            }

                            if (typeof filamentLength == 'number' && typeof filamentVolume == 'number') {
                                this.setStateAsync('printjob.filament.length', Number((filamentLength / 1000).toFixed(2)), true);
                                this.setStateAsync('printjob.filament.volume', Number((filamentVolume).toFixed(2)), true);
                            } else {
                                this.log.debug('Filament length and/or volume contains no valid number');

                                this.setStateAsync('printjob.filament.length', 0, true);
                                this.setStateAsync('printjob.filament.volume', 0, true);
                            }
                        } else {
                            this.setStateAsync('printjob.filament.length', 0, true);
                            this.setStateAsync('printjob.filament.volume', 0, true);
                        }
                    }

                    if (Object.prototype.hasOwnProperty.call(content, 'progress')) {
                        this.setStateAsync('printjob.progress.completion', Math.round(content.progress.completion), true);
                        this.setStateAsync('printjob.progress.filepos', Number((content.progress.filepos / 1024).toFixed(2)), true);
                        this.setStateAsync('printjob.progress.printtime', content.progress.printTime, true);
                        this.setStateAsync('printjob.progress.printtime_left', content.progress.printTimeLeft, true);
                    }
                },
                null
            );
        } else {
            this.log.debug('refreshing state: skipped detail refresh (API not connected)');
        }
    }

    flattenFiles(files) {

        let fileArr = [];

        if (Array.isArray(files)) {
            for (const file of files) {

                if (file.type == 'machinecode' && file.origin == 'local') {

                    fileArr.push(
                        {
                            name: file.display,
                            path: file.origin + '/' + file.path,
                            date: (file.date) ? new Date(file.date * 1000).getTime() : 0
                        }
                    );

                } else if (file.type == 'folder') {
                    fileArr = fileArr.concat(this.flattenFiles(file.children));
                }

            }
        }

        return fileArr;
    }

    async refreshFiles() {

        if (this.apiConnected) {
            this.log.debug('refreshing file list: started');

            this.buildRequest(
                'files?recursive=true',
                (content, status) => {

                    this.getChannelsOf(
                        'files',
                        async (err, states) => {

                            const filesAll = [];
                            const filesKeep = [];

                            // Collect all files
                            if (states) {
                                for (let i = 0; i < states.length; i++) {
                                    const id = this.removeNamespace(states[i]._id);

                                    // Check if the state is a direct child (e.g. files.2)
                                    if (id.split('.').length === 2) {
                                        filesAll.push(id);
                                    }
                                }
                            }

                            const fileList = this.flattenFiles(content.files);
                            this.log.debug('Found ' + fileList.length + ' files');

                            for (const f in fileList) {
                                const file = fileList[f];
                                const fileNameClean = this.cleanNamespace(file.path.replace('.gcode', '').replace('/', ' '));

                                this.log.debug('Found file (clean name): ' + fileNameClean + ' - from: ' + file.path);
                                filesKeep.push('files.' + fileNameClean);

                                await this.setObjectNotExistsAsync('files.' + fileNameClean, {
                                    type: 'channel',
                                    common: {
                                        name: 'File ' + file.name,
                                    },
                                    native: {}
                                });

                                await this.setObjectNotExistsAsync('files.' + fileNameClean + '.name', {
                                    type: 'state',
                                    common: {
                                        name: 'File name',
                                        type: 'string',
                                        role: 'value',
                                        read: true,
                                        write: false
                                    },
                                    native: {}
                                });
                                this.setStateAsync('files.' + fileNameClean + '.name', file.name, true);

                                await this.setObjectNotExistsAsync('files.' + fileNameClean + '.path', {
                                    type: 'state',
                                    common: {
                                        name: 'File path',
                                        type: 'string',
                                        role: 'value',
                                        read: true,
                                        write: false
                                    },
                                    native: {}
                                });
                                this.setStateAsync('files.' + fileNameClean + '.path', file.path, true);

                                await this.setObjectNotExistsAsync('files.' + fileNameClean + '.date', {
                                    type: 'state',
                                    common: {
                                        name: 'File date',
                                        type: 'number',
                                        role: 'date',
                                        read: true,
                                        write: false
                                    },
                                    native: {}
                                });
                                this.setStateAsync('files.' + fileNameClean + '.date', file.date, true);

                                await this.setObjectNotExistsAsync('files.' + fileNameClean + '.select', {
                                    type: 'state',
                                    common: {
                                        name: 'Select file',
                                        type: 'boolean',
                                        role: 'button',
                                        read: false,
                                        write: true
                                    },
                                    native: {}
                                });

                                await this.setObjectNotExistsAsync('files.' + fileNameClean + '.print', {
                                    type: 'state',
                                    common: {
                                        name: 'Print file',
                                        type: 'boolean',
                                        role: 'button',
                                        read: false,
                                        write: true
                                    },
                                    native: {}
                                });

                            }

                            // Delete non existent files
                            for (let i = 0; i < filesAll.length; i++) {
                                const id = filesAll[i];

                                if (filesKeep.indexOf(id) === -1) {
                                    this.delObject(id, {recursive: true}, () => {
                                        this.log.debug('File deleted: "' + id + '"');
                                    });
                                }
                            }
                        }
                    );
                },
                null
            );
        } else {
            this.log.debug('refreshing file list: skipped (API not connected)');
        }
    }

    cleanNamespace(id) {
        return id
            .trim()
            .replace(/\s/g, '_') // Replace whitespaces with underscores
            .replace(/[^\p{Ll}\p{Lu}\p{Nd}]+/gu, '_') // Replace not allowed chars with underscore
            .replace(/[_]+$/g, '') // Remove underscores end
            .replace(/^[_]+/g, '') // Remove underscores beginning
            .replace(/_+/g, '_'); // Replace multiple underscores with one
    }

    removeNamespace(id) {
        const re = new RegExp(this.namespace + '*\.', 'g');
        return id.replace(re, '');
    }

    async buildRequest(service, callback, data) {
        const url = '/api/' + service;
        const method = data ? 'post' : 'get';

        this.log.debug('sending ' + method + ' request to ' + url + ' with data: ' + JSON.stringify(data));

        axios({
            method: method,
            data: data,
            baseURL: 'http://' + this.config.octoprintIp + ':' + this.config.octoprintPort,
            url: url,
            timeout: 2000,
            responseType: 'json',
            headers: {
                'X-Api-Key': this.config.octoprintApiKey
            },
            validateStatus: (status) => {
                return [200, 204, 409].indexOf(status) > -1;
            },
        }).then(response => {
            this.log.debug('received ' + response.status + ' response from ' + url + ' with content: ' + JSON.stringify(response.data));
            // no error - clear up reminder
            delete this.lastErrorCode;

            if (response && callback && typeof callback === 'function') {
                callback(response.data, response.status);
            }
        }).catch(error => {
            if (error.response) {
                // The request was made and the server responded with a status code

                this.log.warn('received error ' + error.response.status + ' response from ' + url + ' with content: ' + JSON.stringify(error.response.data));
            } else if (error.request) {
                // The request was made but no response was received
                // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
                // http.ClientRequest in node.js

                // avoid spamming of the same error when stuck in a reconnection loop
                if (error.code === this.lastErrorCode) {
                    this.log.debug(error.message);
                } else {
                    this.log.info(error.message);
                    this.lastErrorCode = error.code;
                }

                this.setPrinterState(false);
            } else {
                // Something happened in setting up the request that triggered an Error
                this.log.error(error.message);

                this.setPrinterState(false);
            }
        });
    }

    isNewerVersion(oldVer, newVer) {
        const oldParts = oldVer.split('.');
        const newParts = newVer.split('.');
        for (var i = 0; i < newParts.length; i++) {
            const a = ~~newParts[i]; // parse int
            const b = ~~oldParts[i]; // parse int
            if (a > b) return true;
            if (a < b) return false;
        }
        return false;
    }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new OctoPrint(options);
} else {
    // otherwise start the instance directly
    new OctoPrint();
}
