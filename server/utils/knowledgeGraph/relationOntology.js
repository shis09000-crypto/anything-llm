const { RELATION_ONTOLOGY_VERSION } = require("./constants");

const RELATION_TYPES = [
  "related_to",
  "part_of",
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
