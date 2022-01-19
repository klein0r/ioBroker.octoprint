/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
'use strict';

async function refreshValues(adapter) {

    await adapter.setObjectNotExistsAsync('plugins.displayLayerProgress', {
        type: 'channel',
        common: {
            name: 'Display Layer Progress',
        },
        native: {}
    });

    await adapter.setObjectNotExistsAsync('plugins.displayLayerProgress.layer', {
        type: 'channel',
        common: {
            name: {
                en: 'Layer',
                de: 'Schicht',
                ru: 'Слой',
                pt: 'Camada',
                nl: 'Laag',
                fr: 'Couche',
                it: 'Strato',
                es: 'Capa',
                pl: 'Warstwa',
                'zh-cn': '层'
            },
        },
        native: {}
    });

    await adapter.setObjectNotExistsAsync('plugins.displayLayerProgress.layer.current', {
        type: 'state',
        common: {
            name: {
                en: 'Current layer',
                de: 'Aktuelle Ebene',
                ru: 'Текущий слой',
                pt: 'Camada atual',
                nl: 'Huidige laag',
                fr: 'Couche actuelle',
                it: 'Livello attuale',
                es: 'Capa actual',
                pl: 'Aktualna warstwa',
                'zh-cn': '当前层'
            },
            type: 'number',
            role: 'value',
            read: true,
            write: false,
            def: -1
        },
        native: {}
    });

    await adapter.setObjectNotExistsAsync('plugins.displayLayerProgress.layer.total', {
        type: 'state',
        common: {
            name: {
                en: 'Total Layers',
                de: 'Gesamtebenen',
                ru: 'Всего слоев',
                pt: 'Camadas totais',
                nl: 'Totaal aantal lagen',
                fr: 'Couches totales',
                it: 'Strati totali',
                es: 'Capas totales',
                pl: 'Całkowita liczba warstw',
                'zh-cn': '总层数'
            },
            type: 'number',
            role: 'value',
            read: true,
            write: false,
            def: -1
        },
        native: {}
    });

    adapter.buildPluginRequest(
        'DisplayLayerProgress/values'
    ).then(response => {
        if (response.status === 200) {
            if (response.data.layer.current != '-') {
                adapter.setStateAsync('plugins.displayLayerProgress.layer.current', {val: parseInt(response.data.layer.current), ack: true});
            }

            if (response.data.layer.total != '-') {
                adapter.setStateAsync('plugins.displayLayerProgress.layer.total', {val: parseInt(response.data.layer.total), ack: true});
            }
        } else {
            adapter.log.error(`(DisplayLayerProgress/values) status ${response.status}: ${JSON.stringify(response.data)}`);
        }
    }).catch(error => {
    });
}

module.exports = {
    refreshValues: refreshValues
};