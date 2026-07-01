const { SystemPromptVariables } = require("../../models/systemPromptVariables");
const prisma = require("../../utils/prisma");

const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const originalEncryptionKey = process.env.ENCRYPTION_MASTER_KEY;

const mockUser = {
  id: 1,
  username: "john.doe",
  bio: "I am a test user",
};

const mockWorkspace = {
  id: 1,
  name: "Test Workspace",
  slug: 'test-workspace',
};

const mockSystemPromptVariables = [
  {
    id: 1,
    key: "mystaticvariable",
    value: "AnythingLLM testing runtime",
    description: "A test variable",
    type: "static",
    userId: null,
  },
];

describe("SystemPromptVariables.expandSystemPromptVariables", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENCRYPTION_MASTER_KEY = TEST_KEY;
    // Mock just the Prisma actions since that is what is used by default values
    prisma.system_prompt_variables.findMany = jest.fn().mockResolvedValue(mockSystemPromptVariables);
    prisma.system_prompt_variables.findUnique = jest.fn().mockResolvedValue(null);
    prisma.system_prompt_variables.create = jest.fn(async ({ data }) => ({
      id: 2,
      ...data,
    }));
    prisma.workspaces.findUnique = jest.fn().mockResolvedValue(mockWorkspace);
    prisma.users.findUnique = jest.fn().mockResolvedValue(mockUser);
  });

  afterEach(() => {
    if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_MASTER_KEY;
    else process.env.ENCRYPTION_MASTER_KEY = originalEncryptionKey;
  });

  it("should expand user-defined system prompt variables", async () => {
    const variables = await SystemPromptVariables.expandSystemPromptVariables("Hello {mystaticvariable}");
    expect(variables).toBe(`Hello ${mockSystemPromptVariables[0].value}`);
  });

  it("should expand workspace-defined system prompt variables", async () => {
    const variables = await SystemPromptVariables.expandSystemPromptVariables("Hello {workspace.name}", null, mockWorkspace.id);
    expect(variables).toBe(`Hello ${mockWorkspace.name}`);
  });

  it("should expand user-defined system prompt variables", async () => {
    const variables = await SystemPromptVariables.expandSystemPromptVariables("Hello {user.name}", mockUser.id);
    expect(variables).toBe(`Hello ${mockUser.username}`);
  });

  it("should normalize user bio personalization labels for prompts", async () => {
    prisma.users.findUnique = jest.fn().mockResolvedValue({
      ...mockUser,
      bio: "<personalization_profile>\n你的身份: 导师\n</personalization_profile>",
    });
    const variables = await SystemPromptVariables.expandSystemPromptVariables("Hello {user.bio}", mockUser.id);
    expect(variables).toBe("Hello <personalization_profile>\n模型的身份: 导师\n</personalization_profile>");
  });

  it("should work with any combination of variables", async () => {
    const variables = await SystemPromptVariables.expandSystemPromptVariables("Hello {mystaticvariable} {workspace.name} {user.name}", mockUser.id, mockWorkspace.id);
    expect(variables).toBe(`Hello ${mockSystemPromptVariables[0].value} ${mockWorkspace.name} ${mockUser.username}`);
  });

  it("encrypts user-defined variable values at rest and returns plaintext", async () => {
    const { isSecretEncrypted, readSecret } = require("../../utils/security");
    const variable = await SystemPromptVariables.create({
      key: "private_token",
      value: "sensitive prompt token",
      description: "private",
      type: "static",
      userId: mockUser.id,
    });
    const stored = prisma.system_prompt_variables.create.mock.calls[0][0].data;

    expect(isSecretEncrypted(stored.value)).toBe(true);
    expect(readSecret(stored.value)).toBe("sensitive prompt token");
    expect(variable.value).toBe("sensitive prompt token");
  });

  it('should fail gracefully with invalid variables that are undefined for any reason', async () => {
    // Undefined sub-fields on valid classes are push to a placeholder [Class prop]. This is expected behavior.
    const variables = await SystemPromptVariables.expandSystemPromptVariables("Hello {invalid.variable} {user.password} the current user is {user.name} on workspace id #{workspace.id}", null, null);
    expect(variables).toBe("Hello {invalid.variable} [User password] the current user is [User name] on workspace id #[Workspace ID]");
  });
});
