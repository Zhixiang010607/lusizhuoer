"use strict";

// Local source-tree entry. The deployment package uses deploy-index.js as its
// root index.js and places the shared implementation beside it as service.js.
process.env.VERIFICATION_PHOTO_ONLY_FUNCTION = "1";
module.exports = require("../faceRecognition/index.js");
