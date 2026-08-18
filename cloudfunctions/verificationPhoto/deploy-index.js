"use strict";

// ZIP entry: this file is renamed to index.js and the shared implementation is
// copied to service.js. Set the mode before loading it so no face action is
// exposed and the Tencent Face SDK is not required by this function package.
process.env.VERIFICATION_PHOTO_ONLY_FUNCTION = "1";
module.exports = require("./service.js");
