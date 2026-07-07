// Reader HTTP adapter.
//
// The Reader implementation now lives under server/modules/reader so worker,
// storage, and dev-control code can depend on a module boundary instead of this
// endpoint file. Keep this re-export while older tests and callers finish
// migrating away from endpoint-private imports.
module.exports = require("../modules/reader/httpAdapter");
