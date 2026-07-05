class CommandRegistry {
  constructor() {
    this.commands = new Map();
  }

  register(command, handler) {
    if (!command || typeof handler !== "function") {
      throw new Error("Developer command registration requires a handler.");
    }
    this.commands.set(String(command), handler);
  }

  has(command) {
    return this.commands.has(String(command));
  }

  async execute(command, context) {
    const handler = this.commands.get(String(command));
    if (!handler) {
      const error = new Error("Developer command is not registered.");
      error.code = "developer_command_not_registered";
      error.status = 404;
      throw error;
    }
    return await handler(context);
  }

  list() {
    return [...this.commands.keys()].sort();
  }
}

module.exports = {
  CommandRegistry,
};
