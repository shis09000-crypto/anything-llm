ARG BASE_IMAGE=anythingllm-v2-anythingllm:v2.5.76-identity-device-signature-export
FROM ${BASE_IMAGE}

USER root

# Device KEM registration and request-signing verification are owned by the
# Identity runtime. Keep this repair scoped to those two implementation files
# so unrelated API and model runtimes remain byte-for-byte unchanged.
COPY --chown=1000:1000 server/endpoints/clientIdentity.js /app/server/endpoints/clientIdentity.js
COPY --chown=1000:1000 server/utils/requestSigning/index.js /app/server/utils/requestSigning/index.js

RUN cd /app/server \
  && node -c endpoints/clientIdentity.js \
  && node -c utils/requestSigning/index.js \
  && SIG_KEY=identity-build-verification-key \
     SIG_SALT=identity-build-verification-salt \
     ENCRYPTION_MASTER_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
     node -e 'const signing = require("./utils/requestSigning"); if (typeof signing.verifyDeviceSignature !== "function") throw new Error("device_signature_verifier_export_missing")'

LABEL athena.release.id="login-device-key-repair-v2.5.92" \
      athena.release.scope="passkey-device-binding-and-kem-generation-recovery" \
      athena.release.contract="athena-aicp-manifest-v1.1"

USER 1000:1000
