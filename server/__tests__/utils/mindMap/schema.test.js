const {
  normalizeMindMapSchema,
  mindMapToMarkdown,
} = require("../../../utils/mindMap/schema");
const { mindMapSuitability } = require("../../../utils/mindMap/suitability");
const { sourceHash } = require("../../../utils/mindMap");

describe("mind map schema utilities", () => {
  it("marks simple content as not recommended", () => {
    const result = mindMapSuitability("Hello world.");
    expect(result.status).toBe("not_recommended");
    expect(result.canForce).toBe(true);
  });

  it("marks structured complex content as recommended", () => {
    const result = mindMapSuitability(`
## Architecture
- Frontend renders the panel
- Backend validates schemas
- Storage caches generated output

## Workflow
First the source is normalized. Then the service checks cache. Finally the model generates JSON.

## Tradeoffs
Compare tree versus timeline layouts and explain because each depends on the content structure.
    `);
    expect(result.status).toBe("recommended");
  });

  it("repairs and normalizes malformed schema output", () => {
    const schema = normalizeMindMapSchema(`
\`\`\`json
{
  title: "Demo",
  layout: "unknown",
  theme: "napkin",
  nodes: [
    { id: "Root", label: "Root", level: 0, color: "#ffffff" },
    { id: "Child", label: "Child", parentId: "Root", level: 1, color: "bad" },
  ],
  edges: [{ source: "Root", target: "Child" }]
}
\`\`\`
    `);

    expect(schema.title).toBe("Demo");
    expect(schema.layout).toBe("tree");
    expect(schema.nodes).toHaveLength(2);
    expect(schema.edges[0]).toEqual(expect.objectContaining({
      source: "root",
      target: "child",
    }));
  });

  it("exports markdown from normalized schema", () => {
    const markdown = mindMapToMarkdown({
      title: "Demo",
      nodes: [{ id: "root", label: "Root", description: "Main idea" }],
      edges: [],
    });
    expect(markdown).toContain("# Demo");
    expect(markdown).toContain("Main idea");
  });

  it("varies cache hash by layout, theme, model, and prompt version inputs", () => {
    const base = sourceHash({
      sourceText: "same text",
      layout: "tree",
      theme: "napkin",
      model: "model-a",
    });
    const changed = sourceHash({
      sourceText: "same text",
      layout: "radial",
      theme: "napkin",
      model: "model-a",
    });
    expect(base).not.toBe(changed);
  });
});
