'use strict';

const utils = require('@iobroker/adapter-core');
const https = require('node:https');
const axios = require('axios').default;
const adapterName = require('./package.json').name.split('.').pop();

const pluginDisplayLayerProgress = require('./lib/plugins/displaylayerprogress');
const pluginSlicerThumbnails = require('./lib/plugins/slicerthumbnails');

class OctoPrint extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: adapterName,
            useFormatDate: true,
        });

        this.supportedVersion = '1.9.0';
        this.displayedVersionWarning = false;

        this.apiConnected = false;
        this.systemCommands = [];

        this.printerStatus = 'API not connected';
        this.printerOperational = false;
        this.printerPrinting = false;

        this.refreshStateTimeout = null;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        this.setApiConnected(false);

        if (!this.config.octoprintIp) {
            this.log.warn(`OctoPrint ip / hostname not configured - check instance configuration`);
            return;
        }

        if (!this.config.octoprintApiKey) {
            this.log.warn(`API key not configured - check instance configuration`);
            return;
        }

        if (this.config.customName) {
            this.setStateChangedAsync('name', { val: this.config.customName, ack: true });
        } else {
            this.setStateChangedAsync('name', { val: '', ack: true });
        }

        await this.subscribeStatesAsync('*');

        // Delete old (unused) namespace on startup
        await this.delObjectAsync('printjob.progress.printtime_left');
        await this.delObjectAsync('temperature', { recursive: true });

        this.refreshState('onReady');
    }

    /**
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        // No ack = changed by user
        if (id && state && !state.ack) {
            const idNoNamespace = this.removeNamespace(id);

            if (this.apiConnected) {
                if (idNoNamespace.match(new RegExp('tools.tool[0-9]{1}.(targetTemperature|extrude)'))) {
                    const matches = idNoNamespace.match(/tools\.(tool[0-9]{1})\.(targetTemperature|extrude)$/);
                    const toolId = matches[1];
                    const command = matches[2];

                    if (command === 'targetTemperature') {
                        this.log.debug(`changing target "${toolId}" temperature to ${state.val}`);

                        const targetObj = {};
                        targetObj[toolId] = state.val;

                        // https://docs.octoprint.org/en/master/api/printer.html#issue-a-tool-command
                        this.buildServiceRequest('printer/tool', {
                            command: 'target',
                            targets: targetObj,
                        })
                            .then((response) => {
                                if (response.status === 204) {
                                    this.setStateAsync(idNoNamespace, { val: state.val, ack: true });
                                } else {
                                    // 400 Bad Request – If targets or offsets contains a property or tool contains a value not matching the format tool{n}, the target/offset temperature, extrusion amount or flow rate factor is not a valid number or outside of the supported range, or if the request is otherwise invalid.
                                    // 409 Conflict – If the printer is not operational or – in case of select or extrude – currently printing.

                                    this.log.error(`(printer/tool) status ${response.status}: ${JSON.stringify(response.data)}`);
                                }
                            })
                            .catch((err) => {
                                this.log.debug(`(printer/tool) error: ${err}`);
                            });
                    } else if (command === 'extrude') {
                        this.log.debug(`extruding ${state.val}mm`);

                        // https://docs.octoprint.org/en/master/api/printer.html#issue-a-tool-command
                        this.buildServiceRequest('printer/tool', {
                            command: 'extrude',
                            amount: state.val,
                        })
                            .then((response) => {
                                if (response.status === 204) {
                                    this.setStateAsync(idNoNamespace, { val: state.val, ack: true });
                                } else {
                                    // 400 Bad Request – If targets or offsets contains a property or tool contains a value not matching the format tool{n}, the target/offset temperature, extrusion amount or flow rate factor is not a valid number or outside of the supported range, or if the request is otherwise invalid.
                                    // 409 Conflict – If the printer is not operational or – in case of select or extrude – currently printing.

                                    this.log.error(`(printer/tool) status ${response.status}: ${JSON.stringify(response.data)}`);
                                }
                            })
                            .catch((err) => {
                                this.log.debug(`(printer/tool) error: ${err}`);
                            });
                    }
                } else if (idNoNamespace === 'tools.bed.targetTemperature') {
                    this.log.debug(`changing target bed temperature to ${state.val}°C`);

                    // https://docs.octoprint.org/en/master/api/printer.html#issue-a-bed-command
                    this.buildServiceRequest('printer/bed', {
                        command: 'target',
                        target: state.val,
                    })
                        .then((response) => {
                            if (response.status === 204) {
                                this.setStateAsync(idNoNamespace, { val: state.val, ack: true });
                            } else {
                                // 400 Bad Request – If target or offset is not a valid number or outside of the supported range, or if the request is otherwise invalid.
                                // 409 Conflict – If the printer is not operational or the selected printer profile does not have a heated bed.

                                this.log.error(`(printer/bed) status ${response.status}: ${JSON.stringify(response.data)}`);
                            }
                        })
                        .catch((err) => {
                            this.log.debug(`(printer/bed) error: ${err}`);
                        });
                } else if (idNoNamespace === 'command.printer') {
                    const allowedCommandsConnection = ['connect', 'disconnect', 'fake_ack'];
                    const allowedCommandsPrinter = ['home'];

                    if (allowedCommandsConnection.indexOf(state.val) > -1) {
                        this.log.debug(`sending printer connection command: ${state.val}`);

                        // https://docs.octoprint.org/en/master/api/connection.html#issue-a-connection-command
                        this.buildServiceRequest('connection', {
                            command: state.val,
                        })
                            .then((response) => {
                                if (response.status === 204) {
                                    this.setStateAsync(idNoNamespace, { val: state.val, ack: true });
                                    this.refreshState('onStateChange command.printer');
                                } else {
                                    // 400 Bad Request – If the selected port or baudrate for a connect command are not part of the available options.

                                    this.log.error(`(connection) status ${response.status}: ${JSON.stringify(response.data)}`);
                                }
                            })
                            .catch((err) => {
                                this.log.debug(`(connection) error: ${err}`);
                            });
                    } else if (allowedCommandsPrinter.indexOf(state.val) > -1) {
                        this.log.debug(`sending printer command: ${state.val}`);

                        // https://docs.octoprint.org/en/master/api/printer.html#issue-a-print-head-command
                        this.buildServiceRequest('printer/printhead', {
                            command: state.val,
                            axes: ['x', 'y', 'z'],
                        })
                            .then((response) => {
                                if (response.status === 204) {
                                    this.setStateAsync(idNoNamespace, { val: state.val, ack: true });
                                } else {
                                    // 400 Bad Request – Invalid axis specified, invalid value for travel amount for a jog command or factor for feed rate or otherwise invalid request.
                                    // 409 Conflict – If the printer is not operational or currently printing.

                                    this.log.error(`(printer/printhead) status ${response.status}: ${JSON.stringify(response.data)}`);
                                }
                            })
                            .catch((err) => {
                                this.log.debug(`(printer/printhead) error: ${err}`);
                            });
                    } else {
                        this.log.error('printer command not allowed: ' + state.val + '. Choose one of: ' + allowedCommandsConnection.concat(allowedCommandsPrinter).join(', '));
                    }
                } else if (idNoNamespace === 'command.printjob') {
                    const allowedCommands = ['start', 'pause', 'resume', 'cancel', 'restart'];

                    if (allowedCommands.indexOf(state.val) > -1) {
                        this.log.debug(`sending printjob command: ${state.val}`);

                        const printjobCommand = {
                            command: state.val,
                        };

                        // Pause command needs an action
                        if (state.val === 'pause') {
                            printjobCommand.action = 'pause';
                        }

                        // Workaround: Resume is a pause command with resume action
                        if (state.val === 'resume') {
                            printjobCommand.command = 'pause';
                            printjobCommand.action = 'resume';
                        }

                        // https://docs.octoprint.org/en/master/api/job.html#issue-a-job-command
                        this.buildServiceRequest('job', printjobCommand)
                            .then((response) => {
                                if (response.status === 204) {
                                    this.setStateAsync(idNoNamespace, { val: state.val, ack: true });
                                } else {
                                    // 409 Conflict – If the printer is not operational or the current print job state does not match the preconditions for the command.

                                    this.log.error(`(job) status ${response.status}: ${JSON.stringify(response.data)}`);
                                }
                            })
                            .catch((err) => {
                                this.log.debug(`(job) error: ${err}`);
                            });
                    } else {
                        this.log.error('print job command not allowed: ' + state.val + '. Choose one of: ' + allowedCommands.join(', '));
                    }
                } else if (idNoNamespace === 'command.sd') {
                    const allowedCommands = ['init', 'refresh', 'release'];

                    if (allowedCommands.indexOf(state.val) > -1) {
                        this.log.debug(`sending sd card command: ${state.val}`);

                        // https://docs.octoprint.org/en/master/api/printer.html#issue-an-sd-command
                        this.buildServiceRequest('printer/sd', {
                            command: state.val,
                        })
                            .then((response) => {
                                if (response.status === 204) {
                                    this.setStateAsync(idNoNamespace, { val: state.val, ack: true });
                                } else {
                                    // 409 Conflict – If a refresh or release command is issued but the SD card has not been initialized (e.g. via init).

                                    this.log.error(`(printer/sd) status ${response.status}: ${JSON.stringify(response.data)}`);
                                }
                            })
                            .catch((err) => {
                                this.log.debug(`(printer/sd) error: ${err}`);
                            });
                    } else {
                        this.log.error('sd card command not allowed: ' + state.val + '. Choose one of: ' + allowedCommands.join(', '));
                    }
                } else if (idNoNamespace === 'command.custom') {
                    this.log.debug(`sending custom command: ${state.val}`);

                    // https://docs.octoprint.org/en/master/api/printer.html#send-an-arbitrary-command-to-the-printer
                    this.buildServiceRequest('printer/command', {
                        command: state.val,
                    })
                        .then((response) => {
                            if (response.status === 204) {
                                this.setStateAsync(idNoNamespace, { val: state.val, ack: true });
                            } else {
                                // 409 Conflict – If the printer is not operational

                                this.log.error(`(printer/command) status ${response.status}: ${JSON.stringify(response.data)}`);
                            }
                        })
                        .catch((err) => {
                            this.log.debug(`(printer/command) error: ${err}`);
                        });
                } else if (idNoNamespace === 'command.system') {
                    if (this.systemCommands.indexOf(state.val) > -1) {
                        this.log.debug(`sending system command: ${state.val}`);

                        // https://docs.octoprint.org/en/master/api/system.html#execute-a-registered-system-command
                        this.buildServiceRequest('system/commands/' + state.val, {})
                            .then((response) => {
                                if (response.status === 204) {
                                    this.setStateAsync(idNoNamespace, { val: state.val, ack: true });
                                } else {
                                    // 400 Bad Request – If a divider is supposed to be executed or if the request is malformed otherwise
                                    // 404 Not Found – If the command could not be found for source and action
                                    // 500 Internal Server Error – If the command didn’t define a command to execute, the command returned a non-zero return code and ignore was not true or some other internal server error occurred

                                    this.log.error(`(system/commands/*) status ${response.status}: ${JSON.stringify(response.data)}`);
                                }
                            })
                            .catch((err) => {
                                this.log.debug(`(printer/commands/*) error: ${err}`);
                            });
                    } else {
                        this.log.error(`system command not allowed: ${state.val}. Choose one of: ${this.systemCommands.join(', ')}`);
                    }
                } else if (idNoNamespace.indexOf('command.jog.') === 0) {
                    // Validate jog value
                    if (state.val !== 0) {
                        const axis = id.split('.').pop(); // Last element of the object id is the axis
                        const jogCommand = {
                            command: 'jog',
                        };

                        // Add axis
                        jogCommand[axis] = state.val;

                        this.log.debug(`sending jog ${axis} command: ${state.val}`);

                        // https://docs.octoprint.org/en/master/api/printer.html#issue-a-print-head-command
                        this.buildServiceRequest('printer/printhead', jogCommand)
                            .then((response) => {
                                if (response.status === 204) {
                                    this.setStateAsync(idNoNamespace, { val: state.val, ack: true });
                                } else {
                                    // 400 Bad Request – Invalid axis specified, invalid value for travel amount for a jog command or factor for feed rate or otherwise invalid request.
                                    // 409 Conflict – If the printer is not operational or currently printing.

                                    this.log.error(`(printer/printhead) status ${response.status}: ${JSON.stringify(response.data)}`);
                                }
                            })
                            .catch((err) => {
                                this.log.debug(`(printer/printhead) error: ${err}`);
                            });
                    } else {
                        this.log.error('Jog: provide non-zero jog value');
                    }
                } else if (idNoNamespace.match(new RegExp('files.[a-zA-Z0-9_]+.(select|print)'))) {
                    const matches = idNoNamespace.match(/files\.([a-zA-Z0-9_]+)\.(select|print)$/);
                    const fileId = matches[1];
                    const action = matches[2];

                    this.log.debug(`selecting/printing file "${fileId}" - action: "${action}"`);

                    this.getState(`files.${fileId}.path`, (err, state) => {
                        const fullPath = state?.val;

                        this.log.debug(`selecting/printing file with path "${fullPath}"`);

                        // https://docs.octoprint.org/en/master/api/files.html#issue-a-file-command
                        this.buildServiceRequest(`files/${fullPath}`, {
                            command: 'select',
                            print: action === 'print',
                        })
                            .then((response) => {
                                if (response.status === 204) {
                                    this.log.debug('selecting/printing file successful');
                                    this.refreshState(`onStateChange file.${action}`);
                                } else {
                                    this.log.error(`(files/*) status ${response.status}: ${JSON.stringify(response.data)}`);
                                }
                            })
                            .catch((err) => {
                                this.log.debug(`(files/*) error: ${err}`);
                            });
                    });
                }
            }
        }
    }

    setApiConnected(connection) {
        this.setStateChangedAsync('info.connection', { val: connection, ack: true });
        this.apiConnected = connection;

        if (!connection) {
            this.log.debug('API is offline');

            this.printerStatus = 'API not connected';
            this.setStateChangedAsync('printer_status', { val: this.printerStatus, ack: true });
        }
    }

    async refreshState(source) {
        this.log.debug(`refreshState: started from "${source}"`);

        // https://docs.octoprint.org/en/master/api/version.html
        this.buildServiceRequest('version', null)
            .then((response) => {
                if (response.status === 200) {
                    this.setApiConnected(true);

                    this.log.debug(`connected to OctoPrint API - online! - status: ${response.status}`);

                    this.setStateChangedAsync('meta.version', { val: response.data.server, ack: true });
                    this.setStateChangedAsync('meta.api_version', { val: response.data.api, ack: true });

                    if (this.isNewerVersion(response.data.server, this.supportedVersion) && !this.displayedVersionWarning) {
                        this.log.warn(
                            `You should update your OctoPrint installation - supported version of this adapter is ${this.supportedVersion} (or later). Your current version is ${response.data.server}`,
                        );
                        this.displayedVersionWarning = true; // Just show once
                    }

                    this.refreshStateDetails();
                } else {
                    this.log.error(`(version) status ${response.status}: ${JSON.stringify(response.data)}`);
                }
            })
            .catch((error) => {
                this.log.debug(`(version) received error - API is now offline: ${JSON.stringify(error)}`);
                this.setApiConnected(false);
            });

        // Delete old timer
        if (this.refreshStateTimeout) {
            this.log.debug(`refreshStateTimeout: CLEARED by ${source}`);
            this.clearTimeout(this.refreshStateTimeout);
        }

        // Start a new timeout in any case
        if (!this.apiConnected) {
            const notConnectedTimeout = 10;
            this.refreshStateTimeout = this.setTimeout(() => {
                this.refreshStateTimeout = null;
                this.refreshState('timeout (API not connected)');
            }, notConnectedTimeout * 1000);
            this.log.debug(`refreshStateTimeout: re-created refresh timeout (API not connected): id ${this.refreshStateTimeout} - seconds: ${notConnectedTimeout}`);
        } else if (this.printerPrinting) {
            this.refreshStateTimeout = this.setTimeout(() => {
                this.refreshStateTimeout = null;
                this.refreshState('timeout (printing)');
            }, this.config.apiRefreshIntervalPrinting * 1000); // Default 10 sec
            this.log.debug(`refreshStateTimeout: re-created refresh timeout (printing): id ${this.refreshStateTimeout} - seconds: ${this.config.apiRefreshIntervalPrinting}`);
        } else if (this.printerOperational) {
            this.refreshStateTimeout = this.setTimeout(() => {
                this.refreshStateTimeout = null;
                this.refreshState('timeout (operational)');
            }, this.config.apiRefreshIntervalOperational * 1000); // Default 30 sec
            this.log.debug(`refreshStateTimeout: re-created refresh timeout (operational): id ${this.refreshStateTimeout} - seconds: ${this.config.apiRefreshIntervalOperational}`);
        } else {
            this.refreshStateTimeout = this.setTimeout(() => {
                this.refreshStateTimeout = null;
                this.refreshState('timeout (default)');
            }, this.config.apiRefreshInterval * 1000); // Default 60 sec
            this.log.debug(`refreshStateTimeout: re-created refresh timeout (default): id ${this.refreshStateTimeout} - seconds: ${this.config.apiRefreshInterval}`);
        }
    }

    async refreshStateDetails() {
        if (this.apiConnected) {
            // https://docs.octoprint.org/en/master/api/connection.html
            this.buildServiceRequest('connection', null)
                .then((response) => {
                    if (response.status === 200) {
                        this.updatePrinterStatus(response.data.current.state);

                        if (!this.printerPrinting) {
                            this.refreshFiles();
                        }

                        // Try again in 2 seconds
                        if (this.printerStatus === 'Detecting serial connection') {
                            this.setTimeout(() => {
                                this.refreshState('detecting serial connection');
                            }, 2000);
                        }
                    } else {
                        this.log.error(`(connection) status ${response.status}: ${JSON.stringify(response.data)}`);
                    }
                })
                .catch((err) => {
                    this.log.debug(`(connection) error: ${err}`);
                });

            if (this.printerOperational) {
                this.buildServiceRequest('printer', null)
                    .then(async (response) => {
                        const content = response.data;
                        if (content?.temperature) {
                            for (const key of Object.keys(content.temperature)) {
                                const obj = content.temperature[key];

                                const isTool = key.indexOf('tool') > -1;
                                const isBed = key == 'bed';

                                if (isTool || isBed) {
                                    // Tool + bed information

                                    // Create tool channel
                                    await this.setObjectNotExistsAsync(`tools.${key}`, {
                                        type: 'channel',
                                        common: {
                                            name: key,
                                        },
                                        native: {},
                                    });

                                    // Set actual temperature
                                    await this.setObjectNotExistsAsync(`tools.${key}.actualTemperature`, {
                                        type: 'state',
                                        common: {
                                            name: {
                                                en: 'Actual temperature',
                                                de: 'Tatsächliche Temperatur',
                                                ru: 'Фактическая температура',
                                                pt: 'Temperatura real',
                                                nl: 'Werkelijke temperatuur',
                                                fr: 'Température réelle',
                                                it: 'Temperatura effettiva',
                                                es: 'Temperatura real',
                                                pl: 'Rzeczywista temperatura',
                                                uk: 'Погода',
                                                'zh-cn': '实际温度',
                                            },
                                            type: 'number',
                                            role: 'value.temperature',
                                            unit: '°C',
                                            read: true,
                                            write: false,
                                            def: 0,
                                        },
                                        native: {},
                                    });
                                    await this.setStateChangedAsync(`tools.${key}.actualTemperature`, { val: obj.actual, ack: true });

                                    // Set target temperature
                                    await this.setObjectNotExistsAsync(`tools.${key}.targetTemperature`, {
                                        type: 'state',
                                        common: {
                                            name: {
                                                en: 'Target temperature',
                                                de: 'Zieltemperatur',
                                                ru: 'Целевая температура',
                                                pt: 'Temperatura alvo',
                                                nl: 'Doeltemperatuur',
                                                fr: 'Température cible',
                                                it: 'Temperatura obiettivo',
                                                es: 'Temperatura objetivo',
                                                pl: 'Temperatura docelowa',
                                                uk: 'Цільова температура',
                                                'zh-cn': '目标温度',
                                            },
                                            type: 'number',
                                            role: 'value.temperature',
                                            unit: '°C',
                                            read: true,
                                            write: true,
                                        },
                                        native: {},
                                    });
                                    await this.setStateChangedAsync(`tools.${key}.targetTemperature`, { val: obj.target, ack: true });

                                    // Set offset temperature
                                    await this.setObjectNotExistsAsync(`tools.${key}.offsetTemperature`, {
                                        type: 'state',
                                        common: {
                                            name: {
                                                en: 'Offset temperature',
                                                de: 'Offset-Temperatur',
                                                ru: 'Смещение температуры',
                                                pt: 'Temperatura compensada',
                                                nl: 'Offset temperatuur',
                                                fr: 'Température de décalage',
                                                it: 'Temperatura di compensazione',
                                                es: 'Temperatura de compensación',
                                                pl: 'Temperatura przesunięcia',
                                                uk: 'Температура офсету',
                                                'zh-cn': '偏移温度',
                                            },
                                            type: 'number',
                                            role: 'value.temperature',
                                            unit: '°C',
                                            read: true,
                                            write: false,
                                            def: 0,
                                        },
                                        native: {},
                                    });
                                    await this.setStateChangedAsync(`tools.${key}.offsetTemperature`, { val: obj.target, ack: true });
                                }

                                if (isTool) {
                                    // Set extrude
                                    await this.setObjectNotExistsAsync(`tools.${key}.extrude`, {
                                        type: 'state',
                                        common: {
                                            name: {
                                                en: 'Extrude',
                                                de: 'Extrudieren',
                                                ru: 'Выдавливание',
                                                pt: 'Extrudar',
                                                nl: 'extruderen',
                                                fr: 'Extruder',
                                                it: 'Estrudere',
                                                es: 'Extrudir',
                                                pl: 'Wyrzucać',
                                                uk: 'Екструдед',
                                                'zh-cn': '拉伸',
                                            },
                                            type: 'number',
                                            role: 'value',
                                            unit: 'mm',
                                            read: true,
                                            write: true,
                                            def: 0,
                                        },
                                        native: {},
                                    });
                                }
                            }
                        }
                    })
                    .catch((err) => {
                        this.log.debug(`(printer) error: ${err}`);
                    });
            } else {
                // https://docs.octoprint.org/en/master/api/system.html#list-all-registered-system-commands
                this.buildServiceRequest('system/commands', null)
                    .then((response) => {
                        if (response.status === 200) {
                            this.systemCommands = [];

                            for (const key of Object.keys(response.data)) {
                                const arr = response.data[key];
                                arr.forEach((e) => this.systemCommands.push(`${e.source}/${e.action}`));
                            }

                            this.log.debug(`(system/commands) registered commands: ${this.systemCommands.join(', ')}`);
                        }
                    })
                    .catch((err) => {
                        this.log.debug(`(system/commands) error: ${err}`);
                    });
            }

            // Plugin Display Layer Progress
            // https://github.com/OllisGit/OctoPrint-DisplayLayerProgress
            if (this.config.pluginDisplayLayerProgress) {
                this.log.debug('[plugin display layer progress] plugin activated - fetching details');

                pluginDisplayLayerProgress.refreshValues(this);
            } else {
                await this.delObjectAsync('plugins.displayLayerProgress', { recursive: true });
            }

            if (this.printerOperational || this.printerPrinting) {
                // https://docs.octoprint.org/en/master/api/job.html#retrieve-information-about-the-current-job
                this.buildServiceRequest('job', null)
                    .then(async (response) => {
                        if (response.status === 200) {
                            const content = response.data;

                            if (content?.error) {
                                this.log.warn(`print job error: ${content.error}`);
                            }

                            if (content?.job?.file) {
                                const filePath = `${content.job.file.origin}/${content.job.file.path}`;

                                if (this.config.pluginSlicerThumbnails) {
                                    await this.setObjectNotExistsAsync('printjob.file.thumbnail_url', {
                                        type: 'state',
                                        common: {
                                            name: {
                                                en: 'Thumbnail URL',
                                                de: 'Miniaturbild-URL',
                                                ru: 'URL миниатюры',
                                                pt: 'URL da miniatura',
                                                nl: 'Miniatuur-URL',
                                                fr: 'URL de la miniature',
                                                it: 'URL miniatura',
                                                es: 'URL de la miniatura',
                                                pl: 'URL miniatury',
                                                uk: 'Веб-сайт',
                                                'zh-cn': '缩略图网址',
                                            },
                                            type: 'string',
                                            role: 'url',
                                            read: true,
                                            write: false,
                                        },
                                        native: {},
                                    });

                                    this.log.debug(`[plugin slicer thumbnails] trying to find current print job thumbnail url`);

                                    const fileObjectsView = await this.getObjectViewAsync('system', 'channel', {
                                        startkey: this.namespace + '.files.',
                                        endkey: this.namespace + '.files.\u9999',
                                    });

                                    let foundThumbnail = false;

                                    if (fileObjectsView && fileObjectsView.rows) {
                                        // File file where native.path matches current jobs file path
                                        const currentFileObject = fileObjectsView.rows.find((fileObj) => fileObj.value?.native?.path === filePath);
                                        if (currentFileObject) {
                                            const currentFileId = this.removeNamespace(currentFileObject.id);

                                            try {
                                                this.log.debug(`[plugin slicer thumbnails] found current file: ${currentFileId}`);
                                                const currentFileThumbnailUrlState = await this.getStateAsync(`${currentFileId}.thumbnail.url`);

                                                if (currentFileThumbnailUrlState && currentFileThumbnailUrlState.val) {
                                                    foundThumbnail = true;
                                                    await this.setStateChangedAsync('printjob.file.thumbnail_url', { val: currentFileThumbnailUrlState.val, ack: true });
                                                }
                                            } catch (err) {
                                                this.log.debug(`[plugin slicer thumbnails] unable to get value of state ${currentFileId}.thumbnail.url`);
                                            }
                                        }
                                    }

                                    if (!foundThumbnail) {
                                        this.log.debug(`[plugin slicer thumbnails] unable to find file which matches current job file`);
                                        await this.setStateChangedAsync('printjob.file.thumbnail_url', { val: null, ack: true });
                                    }
                                } else {
                                    await this.delObjectAsync('printjob.file.thumbnail_url');
                                }

                                await this.setStateChangedAsync('printjob.file.name', { val: content.job.file.name, ack: true });
                                await this.setStateChangedAsync('printjob.file.origin', { val: content.job.file.origin, ack: true });
                                await this.setStateChangedAsync('printjob.file.size', { val: Number((content.job.file.size / 1024).toFixed(2)), ack: true });
                                await this.setStateChangedAsync('printjob.file.date', { val: new Date(content.job.file.date * 1000).getTime(), ack: true });

                                if (content?.job?.filament) {
                                    let filamentLength = 0;
                                    let filamentVolume = 0;

                                    if (content.job.filament?.tool0) {
                                        filamentLength = content.job.filament?.tool0?.length ?? 0;
                                        filamentVolume = content.job.filament?.tool0?.volume ?? 0;
                                    } else {
                                        filamentLength = content.job.filament?.length ?? 0;
                                        filamentVolume = content.job.filament?.volume ?? 0;
                                    }

                                    if (typeof filamentLength == 'number' && typeof filamentVolume == 'number') {
                                        await this.setStateChangedAsync('printjob.filament.length', { val: Number((filamentLength / 1000).toFixed(2)), ack: true });
                                        await this.setStateChangedAsync('printjob.filament.volume', { val: Number(filamentVolume.toFixed(2)), ack: true });
                                    } else {
                                        this.log.debug('Filament length and/or volume contains no valid number');

                                        await this.setStateChangedAsync('printjob.filament.length', { val: 0, ack: true });
                                        await this.setStateChangedAsync('printjob.filament.volume', { val: 0, ack: true });
                                    }
                                } else {
                                    await this.setStateChangedAsync('printjob.filament.length', { val: 0, ack: true });
                                    await this.setStateChangedAsync('printjob.filament.volume', { val: 0, ack: true });
                                }
                            }

                            if (content?.progress) {
                                await this.setStateChangedAsync('printjob.progress.completion', { val: Math.round(content.progress.completion), ack: true });
                                await this.setStateChangedAsync('printjob.progress.filepos', { val: Number((content.progress.filepos / 1024).toFixed(2)), ack: true });
                                await this.setStateChangedAsync('printjob.progress.printtime', { val: content.progress.printTime, ack: true });
                                await this.setStateChangedAsync('printjob.progress.printtimeLeft', { val: content.progress.printTimeLeft, ack: true });

                                await this.setStateChangedAsync('printjob.progress.printtimeFormat', { val: this.printtimeString(content.progress.printTime), ack: true });
                                await this.setStateChangedAsync('printjob.progress.printtimeLeftFormat', { val: this.printtimeString(content.progress.printTimeLeft), ack: true });

                                const finishedAt = new Date();
                                finishedAt.setSeconds(finishedAt.getSeconds() + content.progress.printTimeLeft);

                                await this.setStateChangedAsync('printjob.progress.finishedAt', { val: finishedAt.getTime(), ack: true });
                                await this.setStateChangedAsync('printjob.progress.finishedAtFormat', { val: this.formatDate(finishedAt), ack: true });
                            }
                        }
                    })
                    .catch((err) => {
                        this.log.debug(`(job) error: ${err}`);
                    });
            } else {
                this.log.debug('refreshing job state: skipped detail refresh (not printing)');

                // Reset all values
                await this.setStateChangedAsync('printjob.file.name', { val: '', ack: true });
                await this.setStateChangedAsync('printjob.file.origin', { val: '', ack: true });
                await this.setStateChangedAsync('printjob.file.size', { val: 0, ack: true });
                await this.setStateChangedAsync('printjob.file.date', { val: 0, ack: true });

                await this.setStateChangedAsync('printjob.filament.length', { val: 0, ack: true });
                await this.setStateChangedAsync('printjob.filament.volume', { val: 0, ack: true });

                await this.setStateChangedAsync('printjob.progress.completion', { val: 0, ack: true });
                await this.setStateChangedAsync('printjob.progress.filepos', { val: 0, ack: true });
                await this.setStateChangedAsync('printjob.progress.printtime', { val: 0, ack: true });
                await this.setStateChangedAsync('printjob.progress.printtimeLeft', { val: 0, ack: true });

                await this.setStateChangedAsync('printjob.progress.printtimeFormat', { val: this.printtimeString(0), ack: true });
                await this.setStateChangedAsync('printjob.progress.printtimeLeftFormat', { val: this.printtimeString(0), ack: true });
            }
        } else {
            this.log.debug('refreshing state: skipped detail refresh (API not connected)');
        }
    }

    flattenFiles(files) {
        let fileArr = [];

        if (Array.isArray(files)) {
            for (const file of files) {
                if (file.type == 'machinecode' && file.origin == 'local') {
                    const fileObj = {
                        name: file.display,
                        path: file.origin + '/' + file.path,
                        date: file.date ? new Date(file.date * 1000).getTime() : 0,
                        size: file.size ? Number(Math.round(file.size / 1024).toFixed(2)) : 0,
                        thumbnail: null,
                    };

                    // Plugin Slicer Thumbnails
                    if (this.config.pluginSlicerThumbnails) {
                        if (file?.thumbnail_src === 'prusaslicerthumbnails') {
                            fileObj.thumbnail = file.thumbnail;
                        }
                    }

                    fileArr.push(fileObj);
                } else if (file.type == 'folder') {
                    fileArr = fileArr.concat(this.flattenFiles(file.children));
                }
            }
        }

        return fileArr;
    }

    async refreshFiles() {
        if (this.apiConnected) {
            this.log.debug('[refreshFiles] started');

            const filesAll = [];
            const filesKeep = [];

            try {
                const fileChannels = await this.getChannelsOfAsync('files');

                // Collect all existing files
                if (fileChannels) {
                    for (let i = 0; i < fileChannels.length; i++) {
                        const idNoNamespace = this.removeNamespace(fileChannels[i]._id);

                        // Check if the state is a direct child (e.g. files.MyCustomFile)
                        if (idNoNamespace.split('.').length === 2) {
                            if (!fileChannels[i].native.path) {
                                // Force recreation of files without native path (upgraded from older version)
                                await this.delObjectAsync(idNoNamespace, { recursive: true });
                                this.log.debug(`[refreshFiles] found file channel without native.path - deleted ${idNoNamespace}`);
                            } else {
                                filesAll.push(idNoNamespace);
                            }
                        }
                    }
                }
            } catch (err) {
                this.log.warn(err);
            }

            this.buildServiceRequest('files?recursive=true', null)
                .then(async (response) => {
                    if (response.status === 200) {
                        const content = response.data;

                        const fileList = this.flattenFiles(content.files);
                        this.log.debug(`[refreshFiles] found ${fileList.length} files`);

                        for (const f in fileList) {
                            const file = fileList[f];
                            const fileNameClean = this.cleanNamespace(file.path.replace('.gcode', '').replace('/', ' '));

                            this.log.debug(`[refreshFiles] found file "${fileNameClean}" (clean name) - location: ${file.path}`);
                            filesKeep.push(`files.${fileNameClean}`);

                            await this.setObjectNotExistsAsync(`files.${fileNameClean}`, {
                                type: 'channel',
                                common: {
                                    name: file.name,
                                },
                                native: {
                                    path: file.path,
                                },
                            });

                            await this.setObjectNotExistsAsync(`files.${fileNameClean}.name`, {
                                type: 'state',
                                common: {
                                    name: {
                                        en: 'File name',
                                        de: 'Dateiname',
                                        ru: 'Имя файла',
                                        pt: 'Nome do arquivo',
                                        nl: 'Bestandsnaam',
                                        fr: 'Nom de fichier',
                                        it: 'Nome del file',
                                        es: 'Nombre del archivo',
                                        pl: 'Nazwa pliku',
                                        uk: `Ім'я файла`,
                                        'zh-cn': '文档名称',
                                    },
                                    type: 'string',
                                    role: 'text',
                                    read: true,
                                    write: false,
                                },
                                native: {},
                            });
                            await this.setStateChangedAsync(`files.${fileNameClean}.name`, { val: file.name, ack: true });

                            await this.setObjectNotExistsAsync(`files.${fileNameClean}.path`, {
                                type: 'state',
                                common: {
                                    name: {
                                        en: 'File path',
                                        de: 'Dateipfad',
                                        ru: 'Путь файла',
                                        pt: 'Caminho de arquivo',
                                        nl: 'Bestandspad',
                                        fr: 'Chemin du fichier',
                                        it: 'Percorso del file',
                                        es: 'Ruta de archivo',
                                        pl: 'Ścieżka pliku',
                                        uk: 'Шлях до файлу',
                                        'zh-cn': '文件路径',
                                    },
                                    type: 'string',
                                    role: 'text',
                                    read: true,
                                    write: false,
                                },
                                native: {},
                            });
                            await this.setStateChangedAsync(`files.${fileNameClean}.path`, { val: file.path, ack: true });

                            await this.setObjectNotExistsAsync(`files.${fileNameClean}.size`, {
                                type: 'state',
                                common: {
                                    name: {
                                        en: 'File size',
                                        de: 'Dateigröße',
                                        ru: 'Размер файла',
                                        pt: 'Tamanho do arquivo',
                                        nl: 'Bestandsgrootte',
                                        fr: 'Taille du fichier',
                                        it: 'Dimensione del file',
                                        es: 'Tamaño del archivo',
                                        pl: 'Rozmiar pliku',
                                        uk: 'Розмір файлу',
                                        'zh-cn': '文件大小',
                                    },
                                    type: 'number',
                                    role: 'value',
                                    unit: 'KiB',
                                    read: true,
                                    write: false,
                                },
                                native: {},
                            });
                            await this.setStateChangedAsync(`files.${fileNameClean}.size`, { val: file.size, ack: true });

                            await this.setObjectNotExistsAsync(`files.${fileNameClean}.date`, {
                                type: 'state',
                                common: {
                                    name: {
                                        en: 'File date',
                                        de: 'Dateidatum',
                                        ru: 'Дата файла',
                                        pt: 'Data do arquivo',
                                        nl: 'Bestandsdatum',
                                        fr: 'Date du fichier',
                                        it: 'Data file',
                                        es: 'Fecha de archivo',
                                        pl: 'Data pliku',
                                        uk: 'Дата файлу',
                                        'zh-cn': '文件日期',
                                    },
                                    type: 'number',
                                    role: 'date',
                                    read: true,
                                    write: false,
                                },
                                native: {},
                            });
                            await this.setStateChangedAsync(`files.${fileNameClean}.date`, { val: file.date, ack: true });

                            if (this.config.pluginSlicerThumbnails) {
                                await this.setObjectNotExistsAsync(`files.${fileNameClean}.thumbnail`, {
                                    type: 'channel',
                                    common: {
                                        name: {
                                            en: 'Thumbnail',
                                            de: 'Miniaturansicht',
                                            ru: 'Миниатюра',
                                            pt: 'Miniatura',
                                            nl: 'Miniatuur',
                                            fr: 'Vignette',
                                            it: 'Miniatura',
                                            es: 'Miniatura',
                                            pl: 'Miniaturka',
                                            uk: 'Напляскване',
                                            'zh-cn': '缩略图',
                                        },
                                    },
                                    native: {},
                                });

                                await this.setObjectNotExistsAsync(`files.${fileNameClean}.thumbnail.url`, {
                                    type: 'state',
                                    common: {
                                        name: {
                                            en: 'Thumbnail URL',
                                            de: 'Miniaturbild-URL',
                                            ru: 'URL миниатюры',
                                            pt: 'URL da miniatura',
                                            nl: 'Miniatuur-URL',
                                            fr: 'URL de la miniature',
                                            it: 'URL miniatura',
                                            es: 'URL de la miniatura',
                                            pl: 'URL miniatury',
                                            uk: 'Веб-сайт',
                                            'zh-cn': '缩略图网址',
                                        },
                                        type: 'string',
                                        role: 'url',
                                        read: true,
                                        write: false,
                                    },
                                    native: {},
                                });

                                // Remove old binary state (deprecated in js-controller 5+)
                                await this.delObjectAsync(`files.${fileNameClean}.thumbnail.png`);
                                if (file.thumbnail) {
                                    this.log.debug(`[refreshFiles] [plugin slicer thumbnails] thumbnail of ${fileNameClean} exists`);

                                    await this.setStateChangedAsync(`files.${fileNameClean}.thumbnail.url`, { val: `${this.getOctoprintUri()}/${file.thumbnail}`, ack: true });
                                }
                            } else {
                                await this.delObjectAsync(`files.${fileNameClean}.thumbnail`, { recursive: true });
                            }

                            await this.setObjectNotExistsAsync(`files.${fileNameClean}.select`, {
                                type: 'state',
                                common: {
                                    name: {
                                        en: 'Select',
                                        de: 'Auswählen',
                                        ru: 'Выбирать',
                                        pt: 'Selecionar',
                                        nl: 'Selecteer',
                                        fr: 'Sélectionner',
                                        it: 'Selezionare',
                                        es: 'Seleccione',
                                        pl: 'Wybierz',
                                        uk: 'Вибрані',
                                        'zh-cn': '选择',
                                    },
                                    type: 'boolean',
                                    role: 'button',
                                    read: false,
                                    write: true,
                                },
                                native: {},
                            });

                            await this.setObjectNotExistsAsync(`files.${fileNameClean}.print`, {
                                type: 'state',
                                common: {
                                    name: {
                                        en: 'Print',
                                        de: 'Drucken',
                                        ru: 'Распечатать',
                                        pt: 'Imprimir',
                                        nl: 'Afdrukken',
                                        fr: 'Imprimer',
                                        it: 'Stampa',
                                        es: 'Impresión',
                                        pl: 'Wydrukować',
                                        uk: 'Друк',
                                        'zh-cn': '打印',
                                    },
                                    type: 'boolean',
                                    role: 'button',
                                    read: false,
                                    write: true,
                                },
                                native: {},
                            });
                        }

                        // Delete non existent files
                        for (const file of filesAll) {
                            if (!filesKeep.includes(file)) {
                                await this.delObjectAsync(file, { recursive: true });
                                this.log.debug(`[refreshFiles] file deleted: "${file}"`);
                            }
                        }

                        if (this.config.pluginSlicerThumbnails) {
                            pluginSlicerThumbnails.downloadThumbnailsToFiles(this);
                        }
                    }
                })
                .catch((err) => {
                    this.log.debug(`(files) error: ${err}`);
                });
        } else {
            this.log.debug('[refreshFiles] skipped (API not connected)');
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
        const re = new RegExp(this.namespace + '*\\.', 'g');
        return id.replace(re, '');
    }

    getOctoprintUri() {
        const prefix = this.config.useHttps ? 'https' : 'http';
        return `${prefix}://${this.config.octoprintIp}:${this.config.octoprintPort}`;
    }

    async buildServiceRequest(service, callback, data) {
        return new Promise((resolve, reject) => {
            this.log.debug('[buildServiceRequest] starting service request');

            this.buildRequest(`/api/${service}`, callback, data).then(resolve, reject);
        });
    }

    async buildPluginRequest(plugin, callback, data) {
        return new Promise((resolve, reject) => {
            this.log.debug('[buildPluginRequest] starting plugin request');

            this.buildRequest(`/plugin/${plugin}`, callback, data).then(resolve, reject);
        });
    }

    async buildRequest(url, data) {
        return new Promise((resolve, reject) => {
            const method = data ? 'post' : 'get';

            if (data) {
                this.log.debug(`sending "${method}" request to "${url}" with data: ${JSON.stringify(data)}`);
            } else {
                this.log.debug(`sending "${method}" request to "${url}" without data`);
            }

            axios({
                method,
                data,
                baseURL: this.getOctoprintUri(),
                url,
                timeout: this.config.apiTimeoutSek * 1000,
                responseType: 'json',
                headers: {
                    'X-Api-Key': this.config.octoprintApiKey,
                },
                validateStatus: (status) => {
                    return [200, 204, 409].indexOf(status) > -1;
                },
                httpsAgent: new https.Agent({
                    rejectUnauthorized: !this.config.allowSelfSignedCertificates,
                }),
            })
                .then((response) => {
                    this.log.debug(`received ${response.status} response from ${url} with content: ${JSON.stringify(response.data)}`);

                    // no error - clear up reminder
                    delete this.lastErrorCode;

                    resolve(response);
                })
                .catch((error) => {
                    if (error.response) {
                        // The request was made and the server responded with a status code

                        this.log.warn(`received ${error.response.status} response from ${url} with content: ${JSON.stringify(error.response.data)}`);
                    } else if (error.request) {
                        // The request was made but no response was received
                        // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
                        // http.ClientRequest in node.js

                        // avoid spamming of the same error when stuck in a reconnection loop
                        if (error.code === this.lastErrorCode) {
                            this.log.debug(error.message);
                        } else {
                            this.log.info(`error ${error.code} from ${url}: ${error.message}`);
                            this.lastErrorCode = error.code;
                        }
                    } else {
                        // Something happened in setting up the request that triggered an Error
                        this.log.error(error.message);
                    }

                    reject(error);
                });
        });
    }

    updatePrinterStatus(printerStatus) {
        this.printerStatus = printerStatus;

        const operationalStates = [
            'Starting',
            'Starting print from SD',
            'Starting to send file to SD', // STATE_STARTING
            'Printing',
            'Printing from SD',
            'Sending file to SD', // STATE_PRINTING
            'Operational', // STATE_OPERATIONAL
            'Paused', // STATE_PAUSED
            'Cancelling', // STATE_CANCELLING
            'Pausing', // STATE_PAUSING
            'Resuming', // STATE_RESUMING
            'Finishing', // STATE_FINISHING
            'Transferring file to SD', // STATE_TRANSFERING_FILE
        ];
        this.printerOperational = operationalStates.indexOf(printerStatus) >= 0;

        const printingStates = [
            'Starting',
            'Starting print from SD',
            'Starting to send file to SD', // STATE_STARTING
            'Printing',
            'Printing from SD',
            'Sending file to SD', // STATE_PRINTING
            'Cancelling', // STATE_CANCELLING
            'Pausing', // STATE_PAUSING
            'Resuming', // STATE_RESUMING
            'Finishing', // STATE_FINISHING
        ];
        this.printerPrinting = printingStates.indexOf(printerStatus) >= 0;

        this.log.debug(`updatePrinterStatus from: "${this.printerStatus}" -> printerOperational: ${this.printerOperational}, printerPrinting: ${this.printerPrinting}`);

        this.setStateChangedAsync('printer_status', { val: this.printerStatus, ack: true });
        this.setStateChangedAsync('operational', { val: this.printerOperational, ack: true });
        this.setStateChangedAsync('printing', { val: this.printerPrinting, ack: true });
    }

    isNewerVersion(oldVer, newVer) {
        const oldParts = oldVer.split('.');
        const newParts = newVer.split('.');
        for (let i = 0; i < newParts.length; i++) {
            const a = ~~newParts[i]; // parse int
            const b = ~~oldParts[i]; // parse int
            if (a > b) return true;
            if (a < b) return false;
        }
        return false;
    }

    printtimeString(seconds) {
        if (seconds < 0) {
            seconds = 0;
        }

        const timeDifference = new Date(seconds * 1000);
        const secondsInADay = 60 * 60 * 1000 * 24;
        const secondsInAHour = 60 * 60 * 1000;
        const days = Math.floor((timeDifference / secondsInADay) * 1);
        let hours = Math.floor(((timeDifference % secondsInADay) / secondsInAHour) * 1);
        let mins = Math.floor((((timeDifference % secondsInADay) % secondsInAHour) / (60 * 1000)) * 1);
        let secs = Math.floor(((((timeDifference % secondsInADay) % secondsInAHour) % (60 * 1000)) / 1000) * 1);

        if (hours < 10) {
            hours = '0' + hours;
        }
        if (mins < 10) {
            mins = '0' + mins;
        }
        if (secs < 10) {
            secs = '0' + secs;
        }

        if (days > 0) {
            return days + 'D' + hours + ':' + mins + ':' + secs;
        } else {
            return hours + ':' + mins + ':' + secs;
        }
    }

    /**
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.setApiConnected(false);

            // Delete old timer
            if (this.refreshStateTimeout) {
                this.log.debug('refreshStateTimeout: UNLOAD');
                this.clearTimeout(this.refreshStateTimeout);
            }

            this.log.debug('cleaned everything up...');
            callback();
        } catch (e) {
            callback();
        }
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
