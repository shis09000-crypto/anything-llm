ARG BASE_IMAGE=anythingllm-v2-anythingllm:v2.5.73-identity-ws-claims
FROM ${BASE_IMAGE}

USER root

# Device-binding recovery and request signing are one Identity runtime
# contract. Keep the verifier private to Identity callers, but export the
# implementation required by the recovery flow.
COPY --chown=1000:1000 server/utils/requestSigning/index.js /app/server/utils/requestSigning/index.js

RUN cd /app/server \
  && node -c utils/requestSigning/index.js \
  && node -e 'const signing = require("./utils/requestSigning"); if (typeof signing.verifyDeviceSignature !== "function") throw new Error("device_signature_verifier_export_missing")'

LABEL athena.release.id="identity-device-signature-export-v2.5.76" \
      athena.release.scope="identity-device-binding-recovery" \
      athena.release.contract="athena-aicp-manifest-v1.1"

USER 1000:1000
