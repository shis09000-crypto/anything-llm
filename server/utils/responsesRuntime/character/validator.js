const {
  CAPABILITY_ID_PATTERN,
  FORBIDDEN_SEMANTIC_KEYS,
  INPUT_ITEM_TYPES,
  ITEM_CAPABILITY_FIELDS,
  ITEM_STATUSES,
  MANIFEST_OBJECT,
  NAMESPACE_PATTERN,
  OUTPUT_ITEM_TYPES,
  PROTOCOL_VERSION,
  RESPONSE_OBJECT,
  RESPONSE_STATUSES,
  SEMVER_PATTERN,
  SHA256_PATTERN,
  isPlainObject,
  validationError,
  validationResult,
} = require("./contract");

function push(errors, code, path, message, details) {
  errors.push(validationError(code, path, message, details));
}

function requireObject(errors, value, path) {
  if (isPlainObject(value)) return true;
  push(errors, "object_required", path, `${path} must be an object.`);
  return false;
}

function requireString(errors, value, path) {
  if (typeof value === "string" && value.length > 0) return true;
  push(errors, "string_required", path, `${path} must be a non-empty string.`);
  return false;
}

function validateCapabilityId(errors, value, path) {
  if (!requireString(errors, value, path)) return false;
  if (CAPABILITY_ID_PATTERN.test(value)) return true;
  push(
    errors,
    "capability_id_invalid",
    path,
    `${path} must use <namespace>:<kind>/<name>.`
  );
  return false;
}

function validateUnitInterval(errors, value, path) {
  if (typeof value === "number" && value >= 0 && value <= 1) return;
  push(errors, "range_invalid", path, `${path} must be between 0 and 1.`);
}

function validateAffect(errors, affect, path) {
  if (!requireObject(errors, affect, path)) return;
  validateCapabilityId(errors, affect.primary, `${path}.primary`);
  if (affect.secondary !== null && affect.secondary !== undefined)
    validateCapabilityId(errors, affect.secondary, `${path}.secondary`);
  validateUnitInterval(errors, affect.intensity, `${path}.intensity`);
  if (
    typeof affect.valence !== "number" ||
    affect.valence < -1 ||
    affect.valence > 1
  )
    push(
      errors,
      "range_invalid",
      `${path}.valence`,
      `${path}.valence must be between -1 and 1.`
    );
  validateUnitInterval(errors, affect.arousal, `${path}.arousal`);
}

function scanForbiddenKeys(errors, value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      scanForbiddenKeys(errors, entry, `${path}[${index}]`)
    );
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (FORBIDDEN_SEMANTIC_KEYS.has(normalized))
      push(
        errors,
        "low_level_field_forbidden",
        `${path}.${key}`,
        `${key} is outside the semantic Character Responses boundary.`
      );
    scanForbiddenKeys(errors, entry, `${path}.${key}`);
  }
}

function validateManifestRef(errors, ref, path) {
  if (!requireObject(errors, ref, path)) return;
  requireString(errors, ref.id, `${path}.id`);
  if (!SEMVER_PATTERN.test(String(ref.version || "")))
    push(
      errors,
      "semver_invalid",
      `${path}.version`,
      `${path}.version must be semantic versioning.`
    );
  if (!SHA256_PATTERN.test(String(ref.sha256 || "")))
    push(
      errors,
      "sha256_invalid",
      `${path}.sha256`,
      `${path}.sha256 must be a lowercase SHA-256 digest.`
    );
}

function validateCharacterRef(errors, character, path = "$.character") {
  if (!requireObject(errors, character, path)) return;
  requireString(errors, character.character_id, `${path}.character_id`);
  requireString(errors, character.instance_id, `${path}.instance_id`);
  validateManifestRef(
    errors,
    character.capability_manifest,
    `${path}.capability_manifest`
  );
}

function validateInput(errors, item, path) {
  if (!requireObject(errors, item, path)) return;
  requireString(errors, item.id, `${path}.id`);
  if (!INPUT_ITEM_TYPES.includes(item.type)) {
    push(
      errors,
      "input_type_invalid",
      `${path}.type`,
      `Unsupported Character input type: ${String(item.type)}.`
    );
    return;
  }
  if (item.type === "user_message") {
    if (!Array.isArray(item.content) || item.content.length === 0)
      push(
        errors,
        "input_content_required",
        `${path}.content`,
        "user_message requires at least one content part."
      );
    else
      item.content.forEach((part, index) => {
        const partPath = `${path}.content[${index}]`;
        if (!isPlainObject(part)) {
          push(
            errors,
            "input_part_invalid",
            partPath,
            "Input part is invalid."
          );
          return;
        }
        if (part.type === "input_text")
          requireString(errors, part.text, `${partPath}.text`);
        else if (part.type === "input_audio_ref")
          requireString(errors, part.audio_ref, `${partPath}.audio_ref`);
        else
          push(
            errors,
            "input_part_type_invalid",
            `${partPath}.type`,
            "Only input_text and input_audio_ref are supported."
          );
      });
  }
  if (item.type === "world_event") {
    requireString(errors, item.name, `${path}.name`);
    if (!Number.isInteger(item.occurred_at) || item.occurred_at < 0)
      push(
        errors,
        "timestamp_invalid",
        `${path}.occurred_at`,
        "world_event.occurred_at must be a non-negative integer."
      );
  }
  if (item.type === "interaction_prediction") {
    requireObject(errors, item.actor, `${path}.actor`);
    requireObject(errors, item.target, `${path}.target`);
    requireString(errors, item.interaction, `${path}.interaction`);
    validateUnitInterval(errors, item.confidence, `${path}.confidence`);
    if (!Number.isInteger(item.eta_ms) || item.eta_ms < 0)
      push(
        errors,
        "eta_invalid",
        `${path}.eta_ms`,
        "interaction_prediction.eta_ms must be a non-negative integer."
      );
  }
}

function validateCharacterRequest(request) {
  const errors = [];
  if (!requireObject(errors, request, "$")) return validationResult(errors);
  if (request.protocol_version !== PROTOCOL_VERSION)
    push(
      errors,
      "protocol_version_unsupported",
      "$.protocol_version",
      `Character Responses v1 requires protocol_version ${PROTOCOL_VERSION}.`
    );
  validateCharacterRef(errors, request.character);
  if (!Array.isArray(request.input) || request.input.length === 0)
    push(errors, "input_required", "$.input", "input must not be empty.");
  else
    request.input.forEach((item, index) =>
      validateInput(errors, item, `$.input[${index}]`)
    );
  if (!requireObject(errors, request.generation, "$.generation")) {
    // requireObject records the error.
  } else {
    if (!["main_agent", "realtime_reaction"].includes(request.generation.mode))
      push(
        errors,
        "generation_mode_invalid",
        "$.generation.mode",
        "generation.mode must be main_agent or realtime_reaction."
      );
    if (
      !Array.isArray(request.generation.channels) ||
      request.generation.channels.length === 0
    )
      push(
        errors,
        "generation_channels_required",
        "$.generation.channels",
        "generation.channels must not be empty."
      );
  }
  scanForbiddenKeys(errors, request);
  return validationResult(errors, request);
}

function validateCommonItem(errors, item, path) {
  if (!requireObject(errors, item, path)) return false;
  requireString(errors, item.id, `${path}.id`);
  if (!OUTPUT_ITEM_TYPES.includes(item.type))
    push(
      errors,
      "output_item_type_invalid",
      `${path}.type`,
      `Unsupported output item type: ${String(item.type)}.`
    );
  if (!ITEM_STATUSES.includes(item.status))
    push(
      errors,
      "output_item_status_invalid",
      `${path}.status`,
      `Unsupported output item status: ${String(item.status)}.`
    );
  if (typeof item.required !== "boolean")
    push(
      errors,
      "required_flag_invalid",
      `${path}.required`,
      "required must be boolean."
    );
  if (!requireObject(errors, item.timing, `${path}.timing`)) {
    // requireObject records the error.
  } else if (
    item.timing.start === "after_item" &&
    typeof item.timing.after_item_id !== "string"
  )
    push(
      errors,
      "timing_dependency_required",
      `${path}.timing.after_item_id`,
      "after_item timing requires after_item_id."
    );
  if (
    !["immediate", "blend_out", "at_boundary", "finish"].includes(
      item.interruptibility
    )
  )
    push(
      errors,
      "interruptibility_invalid",
      `${path}.interruptibility`,
      "interruptibility is invalid."
    );
  return true;
}

function validateOutputItem(errors, item, path, primaryIntentId) {
  if (!validateCommonItem(errors, item, path)) return;
  if (item.type === "performance_intent") {
    if (item.intent_id !== undefined)
      push(
        errors,
        "intent_self_reference_forbidden",
        `${path}.intent_id`,
        "performance_intent must not reference another intent."
      );
    validateAffect(errors, item.affect, `${path}.affect`);
    if (
      ![
        "runtime_default",
        "local_reaction",
        "main_agent",
        "high_priority_event",
      ].includes(item.source)
    )
      push(
        errors,
        "performance_source_invalid",
        `${path}.source`,
        "performance_intent.source is invalid."
      );
    return;
  }
  if (!primaryIntentId || item.intent_id !== primaryIntentId)
    push(
      errors,
      "performance_intent_reference_invalid",
      `${path}.intent_id`,
      "Every non-intent item must reference the first performance_intent."
    );
  const capabilityField = ITEM_CAPABILITY_FIELDS[item.type];
  if (capabilityField)
    validateCapabilityId(
      errors,
      item[capabilityField],
      `${path}.${capabilityField}`
    );
  if (item.type === "gaze")
    validateCapabilityId(errors, item.style, `${path}.style`);
  if (item.type === "speech") {
    if (typeof item.text !== "string")
      push(
        errors,
        "speech_text_invalid",
        `${path}.text`,
        "speech.text must be a string."
      );
    if (requireObject(errors, item.delivery, `${path}.delivery`)) {
      validateCapabilityId(
        errors,
        item.delivery.emotion,
        `${path}.delivery.emotion`
      );
      if (item.delivery.emotion_source !== "performance_intent")
        push(
          errors,
          "speech_emotion_source_invalid",
          `${path}.delivery.emotion_source`,
          "speech emotion must be resolved from performance_intent."
        );
      validateCapabilityId(
        errors,
        item.delivery.style,
        `${path}.delivery.style`
      );
    }
  }
  if (item.type === "extension") {
    if (!NAMESPACE_PATTERN.test(String(item.namespace || "")))
      push(
        errors,
        "extension_namespace_invalid",
        `${path}.namespace`,
        "extension.namespace is invalid."
      );
    if (!SEMVER_PATTERN.test(String(item.version || "")))
      push(
        errors,
        "semver_invalid",
        `${path}.version`,
        "extension.version must use semantic versioning."
      );
  }
}

function validateCharacterResponse(response) {
  const errors = [];
  if (!requireObject(errors, response, "$")) return validationResult(errors);
  if (response.object !== RESPONSE_OBJECT)
    push(
      errors,
      "response_object_invalid",
      "$.object",
      `object must be ${RESPONSE_OBJECT}.`
    );
  if (response.protocol_version !== PROTOCOL_VERSION)
    push(
      errors,
      "protocol_version_unsupported",
      "$.protocol_version",
      `protocol_version must be ${PROTOCOL_VERSION}.`
    );
  if (!RESPONSE_STATUSES.includes(response.status))
    push(
      errors,
      "response_status_invalid",
      "$.status",
      "Character response status is invalid."
    );
  validateCharacterRef(errors, response.character);
  validateManifestRef(
    errors,
    response.capability_manifest,
    "$.capability_manifest"
  );
  if (!Array.isArray(response.output))
    push(errors, "output_invalid", "$.output", "output must be an array.");
  else {
    if (
      ["completed", "incomplete"].includes(response.status) &&
      response.output.length === 0
    )
      push(
        errors,
        "performance_intent_required",
        "$.output[0]",
        "Completed and incomplete responses require a performance_intent."
      );
    if (
      response.output.length > 0 &&
      response.output[0]?.type !== "performance_intent"
    )
      push(
        errors,
        "performance_intent_must_be_first",
        "$.output[0].type",
        "The first output item must be performance_intent."
      );
    const ids = new Set();
    const primaryIntentId =
      response.output[0]?.type === "performance_intent"
        ? response.output[0].id
        : null;
    response.output.forEach((item, index) => {
      const path = `$.output[${index}]`;
      validateOutputItem(errors, item, path, primaryIntentId);
      if (typeof item?.id === "string") {
        if (ids.has(item.id))
          push(
            errors,
            "output_item_id_duplicate",
            `${path}.id`,
            `Duplicate output item id: ${item.id}.`
          );
        ids.add(item.id);
      }
    });
    const primaryEmotion = response.output[0]?.affect?.primary;
    response.output.forEach((item, index) => {
      if (
        item?.type === "speech" &&
        item.delivery?.emotion &&
        primaryEmotion &&
        item.delivery.emotion !== primaryEmotion
      )
        push(
          errors,
          "speech_emotion_conflict",
          `$.output[${index}].delivery.emotion`,
          "speech.delivery.emotion must match the primary Performance Intent; intentional differences belong in channel_modulation.voice."
        );
    });
  }
  scanForbiddenKeys(errors, response.output || []);
  return validationResult(errors, response);
}

function capabilityNamespace(capabilityId) {
  return String(capabilityId || "").split(":", 1)[0];
}

function validateCapabilityManifest(manifest) {
  const errors = [];
  if (!requireObject(errors, manifest, "$")) return validationResult(errors);
  if (manifest.schema !== MANIFEST_OBJECT)
    push(
      errors,
      "manifest_object_invalid",
      "$.schema",
      `schema must be ${MANIFEST_OBJECT}.`
    );
  if (manifest.schema_version !== PROTOCOL_VERSION)
    push(
      errors,
      "manifest_version_unsupported",
      "$.schema_version",
      `schema_version must be ${PROTOCOL_VERSION}.`
    );
  if (!NAMESPACE_PATTERN.test(String(manifest.namespace || "")))
    push(
      errors,
      "manifest_namespace_invalid",
      "$.namespace",
      "Manifest namespace is invalid."
    );
  if (!SEMVER_PATTERN.test(String(manifest.version || "")))
    push(
      errors,
      "semver_invalid",
      "$.version",
      "Manifest version must use semantic versioning."
    );
  if (
    !Array.isArray(manifest.capabilities) ||
    manifest.capabilities.length === 0
  )
    push(
      errors,
      "manifest_capabilities_required",
      "$.capabilities",
      "Manifest capabilities must not be empty."
    );
  else {
    const ids = new Set();
    manifest.capabilities.forEach((capability, index) => {
      const path = `$.capabilities[${index}]`;
      if (!requireObject(errors, capability, path)) return;
      if (validateCapabilityId(errors, capability.id, `${path}.id`)) {
        if (ids.has(capability.id))
          push(
            errors,
            "manifest_capability_duplicate",
            `${path}.id`,
            `Duplicate capability: ${capability.id}.`
          );
        ids.add(capability.id);
        if (capabilityNamespace(capability.id) !== manifest.namespace)
          push(
            errors,
            "manifest_namespace_collision",
            `${path}.id`,
            `Capability namespace must match ${manifest.namespace}.`
          );
      }
      if (!SEMVER_PATTERN.test(String(capability.version || "")))
        push(
          errors,
          "semver_invalid",
          `${path}.version`,
          "Capability version must use semantic versioning."
        );
      if (capability.fallback !== undefined)
        validateCapabilityId(errors, capability.fallback, `${path}.fallback`);
    });
  }
  if (
    manifest.namespace?.startsWith("athena.") &&
    !manifest.id?.startsWith("athena.")
  )
    push(
      errors,
      "reserved_namespace_denied",
      "$.namespace",
      "Only Athena-owned manifests may use the athena.* namespace."
    );
  if (isPlainObject(manifest.fallbacks))
    for (const [from, to] of Object.entries(manifest.fallbacks)) {
      validateCapabilityId(errors, from, `$.fallbacks.${from}`);
      validateCapabilityId(errors, to, `$.fallbacks.${from}`);
    }
  else
    push(
      errors,
      "manifest_fallbacks_invalid",
      "$.fallbacks",
      "Manifest fallbacks must be an object."
    );
  if (manifest.fallback_policy?.max_depth !== 4)
    push(
      errors,
      "manifest_fallback_depth_invalid",
      "$.fallback_policy.max_depth",
      "v1 fallback depth must be 4."
    );
  if (!SHA256_PATTERN.test(String(manifest.integrity?.sha256 || "")))
    push(
      errors,
      "sha256_invalid",
      "$.integrity.sha256",
      "Manifest integrity.sha256 must be a lowercase SHA-256 digest."
    );
  return validationResult(errors, manifest);
}

module.exports = {
  scanForbiddenKeys,
  validateCapabilityManifest,
  validateCharacterRequest,
  validateCharacterResponse,
};
