let apiUrl = 'https://api.ellipsis-drive.com/v1';

function CustomError(status, message) {
    var error = Error.call(this, message);

    this.name = 'API Error';
    this.message = error.message;
    this.stack = error.stack;
    this.status = status;
}

async function ellipsisApiManagerFetch(method, url, body, user) {
    let headers = {};
    let urlAddition = '';

    headers['Content-Type'] = 'application/json';

    if (user) {
        headers['Authorization'] = `Bearer ${user.token}`;
        if (user.mapId) {
            urlAddition = `?mapId=${user.mapId}`;
        }
    }

    url = `${apiUrl}${url}${urlAddition}`;
    let gottenResponse = null;
    let isText = false;
    let isJson = false;

    let options = {
        method: method,
        headers: headers,
    };

    if (body) {
        options.body = JSON.stringify(body);
    }

    return await fetch(url, options)
        .then((response) => {
            if (!response.ok) {
                if (response.status === 429) {
                    alert(
                        `You made too many calls to this map and won't be able to use it for another minute. Contact the owner of this map to give you more bandwidth.`
                    );
                }
            }

            gottenResponse = response;

            let contentType = response.headers.get('Content-Type');

            if (contentType) {
                isText = contentType.includes('text');
                isJson = contentType.includes('application/json');
            } else {
                isText = true;
            }

            if (isJson) {
                return response.json();
            } else if (isText) {
                return response.text();
            } else {
                return response.blob();
            }
        })
        .then((result) => {
            if (gottenResponse.status === 200) {
                return result;
            } else {
                if (!isText) {
                    throw new CustomError(gottenResponse.status, result.message);
                } else {
                    throw new CustomError(gottenResponse.status, result);
                }
            }
        });
}

const EllipsisApi = {

    setApiUrl: (newUrl) => apiUrl = newUrl,
    /**
     * @deprecated Please use getApiUrl() instead.
     */
    apiUrl: apiUrl,
    /**
     * Get the url of the api.
     * @returns {string}
     */
    getApiUrl: () => apiUrl,

    /**
     * Send a post request to the ellipsis api.
     * @param {string} url 
     * @param {object} body 
     * @param {{token: string}} user 
     * @returns 
     */
    post: (url, body, user) => {
        return ellipsisApiManagerFetch('POST', url, body, user);
    },

    /**
     * Login into an ellipsis drive account with a username and password
     * @param {string} username 
     * @param {string} password 
     * @returns 
     */
    login: (username, password) => {
        return ellipsisApiManagerFetch('POST', '/account/login', { username, password });
    },

    /**
     * Get metadata for something stored in your drive.
     * @param {string} pathId the id of something stored in your drive like a block, shape or folder
     * @param {{token: string}} user 
     * @returns metadata of the given map/shape/folder
     */
    getInfo: (pathId, user) => {
        return ellipsisApiManagerFetch('POST', '/info', { pathId }, user);
    },

    /**
     * @deprecated The metadata request was ported to an info request. So please use getInfo() instead.
     * @param {string} blockId 
     * @param {boolean} includeDeleted 
     * @param {{token: string}} user 
     * @returns 
     */
    getMetadata: (blockId, includeDeleted, user) => {
        let body;
        if (includeDeleted) body = { mapId: blockId, includeDeleted };
        else body = { mapId: blockId };

        return ellipsisApiManagerFetch('POST', '/metadata', body, user);
    },

}

export default EllipsisApi;