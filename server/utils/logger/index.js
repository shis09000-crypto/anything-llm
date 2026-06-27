const winston = require("winston");
const fs = require("fs");
const path = require("path");
const { sanitizeLogArgs } = require("../security/redaction");

function fileLogger(service) {
  const logDir = process.env.DESKTOP_LOG_DIR;
  if (!logDir) return null;
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${service}.log`);
  const maxBytes = 5 * 1024 * 1024;
  const maxRotatedLogs = 5;

  function rotateIfNeeded() {
    try {
      if (!fs.existsSync(logFile) || fs.statSync(logFile).size < maxBytes)
        return;
      for (let index = maxRotatedLogs - 1; index >= 1; index -= 1) {
        const from = `${logFile}.${index}`;
        const to = `${logFile}.${index + 1}`;
        if (fs.existsSync(to)) fs.rmSync(to, { force: true });
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      fs.renameSync(logFile, `${logFile}.1`);
    } catch {}
  }

  return function append(level, args) {
    rotateIfNeeded();
    const message = sanitizeLogArgs(args)
      .map((arg) => {
        if (typeof arg === "object") {
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        }
        return String(arg);
      })
      .join(" ");
    fs.appendFileSync(
      logFile,
      JSON.stringify({ ts: new Date().toISOString(), level, message }) + "\n"
    );
  };
}

class Logger {
  logger = console;
  static _instance;
  constructor() {
    if (Logger._instance) return Logger._instance;
    this.attachConsoleRedaction();
    this.logger =
      process.env.NODE_ENV === "production" ? this.getWinstonLogger() : console;
    this.attachDesktopFileLogger();
    Logger._instance = this;
  }

  attachConsoleRedaction() {
    if (console.__athenaRedactionAttached) return;
    console.__athenaRedactionAttached = true;
    const original = {
      log: console.log.bind(console),
      error: console.error.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      debug: console.debug.bind(console),
    };
    console.log = (...args) => original.log(...sanitizeLogArgs(args));
    console.error = (...args) => original.error(...sanitizeLogArgs(args));
    console.info = (...args) => original.info(...sanitizeLogArgs(args));
    console.warn = (...args) => original.warn(...sanitizeLogArgs(args));
    console.debug = (...args) => original.debug(...sanitizeLogArgs(args));
  }

  attachDesktopFileLogger() {
    const append = fileLogger("server");
    if (!append || console.__desktopFileLoggerAttached) return;
    console.__desktopFileLoggerAttached = true;
    const original = {
      log: console.log.bind(console),
      error: console.error.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
    };
    console.log = (...args) => {
      append("info", args);
      original.log(...args);
    };
    console.error = (...args) => {
      append("error", args);
      original.error(...args);
    };
    console.info = (...args) => {
      append("info", args);
      original.info(...args);
    };
    console.warn = (...args) => {
      append("warn", args);
      original.warn(...args);
    };
  }

  getWinstonLogger() {
    const logger = winston.createLogger({
      level: "info",
      defaultMeta: { service: "backend" },
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.printf(
              ({ level, message, service, origin = "" }) => {
                return `\x1b[36m[${service}]\x1b[0m${origin ? `\x1b[33m[${origin}]\x1b[0m` : ""} ${level}: ${message}`;
              }
            )
          ),
        }),
      ],
    });

    function formatArgs(args) {
      return sanitizeLogArgs(args)
        .map((arg) => {
          if (typeof arg === "object") {
            return JSON.stringify(arg); // Convert objects to JSON string
          } else {
            return arg; // Otherwise, return as-is
          }
        })
        .join(" ");
    }

    console.log = function (...args) {
      logger.info(formatArgs(args));
    };
    console.error = function (...args) {
      logger.error(formatArgs(args));
    };
    console.info = function (...args) {
      logger.warn(formatArgs(args));
    };
    return logger;
  }
}

/**
 * Sets and overrides Console methods for logging when called.
 * This is a singleton method and will not create multiple loggers.
 * @returns {winston.Logger | console} - instantiated logger interface.
 */
function setLogger() {
  return new Logger().logger;
}
module.exports = setLogger;
