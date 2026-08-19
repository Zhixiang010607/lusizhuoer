"use strict";

// Local source-tree entry. The deployment package uses deploy-index.js as its
// root index.js and places the shared implementation beside it as service.js.
process.env.VERIFICATION_PHOTO_ONLY_FUNCTION = "1";
const CloudBaseManager = require("@cloudbase/manager-node");
const {
  createVerificationPhotoMain,
  installManagerSigningReliability
} = require("./read-reliability.js");

installManagerSigningReliability(CloudBaseManager);
const sharedService = require("../faceRecognition/index.js");
module.exports = { main: createVerificationPhotoMain(sharedService.main) };
