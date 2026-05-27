const { RELATION_ONTOLOGY_VERSION } = require("./constants");

const RELATION_TYPES = [
  "related_to",
  "part_of",
  "influences",
  "influenced_by",
  "criticizes",
  "develops",
  "introduces_concept",
  "belongs_to_school",
  "answers_question",
  "often_confused_with",
  "supports_claim",
  "refutes_claim",
  "prerequisite_of",
  "open_question_for",
  "evidence_for",
  "leads_to",
  "causes",
  "depends_on",
  "used_in",
  "acts_at",
  "regulates",
  "contrasts_with",
  "precedes",
  "implements",
  "references",
];

const ALIASES = {
  related_to: ["related", "associated_with", "connected_to", "links_to"],
  part_of: ["contains", "component_of", "belongs_to", "has_part"],
  influences: ["influences", "affects", "shapes"],
  influenced_by: ["influenced_by", "shaped_by"],
  criticizes: ["criticises", "opposes", "argues_against"],
  develops: ["extends", "elaborates", "builds_on"],
  introduces_concept: ["introduces", "defines", "coins"],
  belongs_to_school: ["school_of", "member_of_school", "belongs_to"],
  answers_question: ["answers", "responds_to"],
  often_confused_with: ["confused_with", "mistaken_for"],
  supports_claim: ["supports", "evidence_supports"],
  refutes_claim: ["refutes", "disproves", "challenges"],
  prerequisite_of: ["prerequisite_for", "foundation_for"],
  open_question_for: ["open_question", "unresolved_for"],
  evidence_for: ["evidence_of", "proves"],
  leads_to: ["leads_to", "results_in"],
  causes: ["causes", "leads_to", "results_in", "drives", "produces"],
  depends_on: ["requires", "relies_on", "needs", "depends_on"],
  used_in: ["used_for", "applied_in", "participates_in", "involved_in"],
  acts_at: ["located_at", "acts_on", "binds_at", "occurs_at"],
  regulates: ["controls", "modulates", "activates", "inhibits", "affects"],
  contrasts_with: ["compared_to", "differs_from", "opposes", "versus"],
  precedes: ["before", "followed_by", "then", "next"],
  implements: ["implements", "realizes", "provides", "builds"],
  references: ["mentions", "cites", "refers_to", "points_to"],
};

function relationKey(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeRelationType(value = "") {
  const key = relationKey(value);
  if (RELATION_TYPES.includes(key)) {
    return {
      relationType: key,
      relationLabel: key,
      relationOntologyVersion: RELATION_ONTOLOGY_VERSION,
    };
  }

  for (const [canonical, aliases] of Object.entries(ALIASES)) {
    if (aliases.map(relationKey).includes(key)) {
      return {
        relationType: canonical,
        relationLabel: String(value || canonical),
        relationOntologyVersion: RELATION_ONTOLOGY_VERSION,
      };
    }
  }

  return {
    relationType: "related_to",
    relationLabel: String(value || "related_to"),
    relationOntologyVersion: RELATION_ONTOLOGY_VERSION,
  };
}

module.exports = {
  RELATION_TYPES,
  RELATION_ONTOLOGY_VERSION,
  normalizeRelationType,
};
