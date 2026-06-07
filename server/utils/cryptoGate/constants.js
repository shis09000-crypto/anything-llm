const GATE_REST_BASE_URL = "https://api.gateio.ws/api/v4";
const GATE_REST_PREFIX = "/api/v4";
const GATE_WS_SPOT_URL = "wss://api.gateio.ws/ws/v4/";
const GATE_WS_FUTURES_USDT_URL = "wss://fx-ws.gateio.ws/v4/ws/usdt";
const DEFAULT_SPOT_PAIR = "BTC_USDT";

module.exports = {
  DEFAULT_SPOT_PAIR,
  GATE_REST_BASE_URL,
  GATE_REST_PREFIX,
  GATE_WS_FUTURES_USDT_URL,
  GATE_WS_SPOT_URL,
};
