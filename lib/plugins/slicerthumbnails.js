'use strict';

const https = require('node:https');
const axios = require('axios').default;

async function downloadThumbnailsToFiles(adapter) {
    const fileChannels = await adapter.getChannelsOfAsync('files');

    // Collect all existing files
    if (fileChannels) {
        for (let i = 0; i < fileChannels.length; i++) {
            const idNoNamespace = adapter.removeNamespace(fileChannels[i]._id);

            // Check if the state is a direct child (e.g. files.MyCustomFile)
            if (idNoNamespace.split('.').length === 2) {
                const urlState = await adapter.getStateAsync(`${idNoNamespace}.thumbnail.url`);

                if (urlState && urlState.val) {
                    const filePath = `${idNoNamespace}.png`;
                    const thumbnailUrl = urlState.val;

                    await downloadThumbnailFor(adapter, filePath, thumbnailUrl);
                }
            }
        }
    }
}

async function downloadThumbnailFor(adapter, filePath, thumbnailUrl) {
    try {
        const response = await axios.get(thumbnailUrl, {
            responseType: 'arraybuffer',
            timeout: adapter.config.apiTimeoutSek * 1000,
            validateStatus: (status) => {
                return [200].indexOf(status) > -1;
            },
            httpsAgent: new https.Agent({
                rejectUnauthorized: !adapter.config.allowSelfSignedCertificates,
            }),
        });

        if (response.data) {
            const responseType = Object.prototype.toString.call(response.data);
            adapter.log.debug(`[downloadThumbnailFor] [plugin slicer thumbnails] received data as ${responseType} for ${thumbnailUrl}: ${JSON.stringify(response.headers)}`);

            adapter.writeFile(adapter.namespace, filePath, Buffer.from(response.data), () => {
                adapter.log.debug(`[downloadThumbnailFor] [plugin slicer thumbnails] saved file information in ${filePath}`);
            });
        } else {
            adapter.log.debug(`[downloadThumbnailFor] [plugin slicer thumbnails] response was empty: ${JSON.stringify(response.headers)}`);
        }
    } catch (error) {
        if (error.response) {
            // The request was made and the server responded with a status code

            adapter.log.warn(`[downloadThumbnailFor] [plugin slicer thumbnails] received ${error.response.status} response from ${thumbnailUrl}`);
        } else if (error.request) {
            // The request was made but no response was received
            // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
            // http.ClientRequest in node.js

            adapter.log.info(`[downloadThumbnailFor] [plugin slicer thumbnails] error ${error.code} from ${thumbnailUrl}: ${error.message}`);
        } else {
            // Something happened in setting up the request that triggered an Error
            adapter.log.error(error.message);
        }
    }
}

module.exports = {
    downloadThumbnailsToFiles: downloadThumbnailsToFiles,
};
