const {
  MarketDataError,
  fetchJson,
  jsonTool,
  optionalString,
} = require("../market-data/lib");
const { readManagedSecret } = require("../market-data/secrets");

const QWEATHER_API_HOST = "nk4ewrbbdn.re.qweatherapi.com";
const LOCATION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const CURRENT_TTL_MS = 5 * 60 * 1_000;
const locationCache = new Map();
const currentCache = new Map();
const forecastCache = new Map();

const PROVINCE_CAPITALS = Object.freeze({
  福建: "福州",
  福建省: "福州",
  广东: "广州",
  广东省: "广州",
  浙江: "杭州",
  浙江省: "杭州",
  江苏: "南京",
  江苏省: "南京",
  四川: "成都",
  四川省: "成都",
  湖北: "武汉",
  湖北省: "武汉",
  湖南: "长沙",
  湖南省: "长沙",
  山东: "济南",
  山东省: "济南",
  河南: "郑州",
  河南省: "郑州",
  陕西: "西安",
  陕西省: "西安",
  安徽: "合肥",
  安徽省: "合肥",
  云南: "昆明",
  云南省: "昆明",
  河北: "石家庄",
  河北省: "石家庄",
  山西: "太原",
  山西省: "太原",
  辽宁: "沈阳",
  辽宁省: "沈阳",
  吉林: "长春",
  吉林省: "长春",
  黑龙江: "哈尔滨",
  黑龙江省: "哈尔滨",
  江西: "南昌",
  江西省: "南昌",
  广西: "南宁",
  广西壮族自治区: "南宁",
  新疆: "乌鲁木齐",
  新疆维吾尔自治区: "乌鲁木齐",
  西藏: "拉萨",
  西藏自治区: "拉萨",
  内蒙古: "呼和浩特",
  内蒙古自治区: "呼和浩特",
  宁夏: "银川",
  宁夏回族自治区: "银川",
  海南: "海口",
  海南省: "海口",
  甘肃: "兰州",
  甘肃省: "兰州",
  青海: "西宁",
  青海省: "西宁",
  贵州: "贵阳",
  贵州省: "贵阳",
  北京市: "北京",
  上海市: "上海",
  重庆市: "重庆",
  天津市: "天津",
});

function cacheGet(cache, key) {
  const entry = cache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(cache, key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function msUntilTomorrow() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setHours(24, 0, 0, 0);
  return Math.max(60_000, tomorrow.getTime() - now.getTime());
}

function normalizeLocation(input = "") {
  const trimmed = String(input).trim();
  const mapped = PROVINCE_CAPITALS[trimmed];
  if (mapped)
    return {
      input: trimmed,
      query: mapped,
      note: `已将 ${trimmed} 默认映射为省会/直辖市城市 ${mapped}`,
    };
  const query = trimmed.replace(/(自治州|地区|市|区|县)$/u, "");
  return { input: trimmed, query, note: null };
}

function validateCoordinates(lat, lon) {
  if ((lat === undefined) !== (lon === undefined))
    throw new MarketDataError(
      "invalid_input",
      "lat and lon must be provided together."
    );
  if (lat === undefined) return null;
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  )
    throw new MarketDataError(
      "invalid_input",
      "Invalid latitude or longitude."
    );
  return { latitude, longitude };
}

async function qweather(path, params, dependencies = {}) {
  const apiKey = dependencies.apiKey || readManagedSecret("qweather");
  const query = new URLSearchParams(params);
  return await fetchJson(
    `https://${QWEATHER_API_HOST}${path}?${query.toString()}`,
    {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "identity",
        "X-QW-Api-Key": apiKey,
      },
    },
    dependencies.fetchImpl
  );
}

function assertQWeatherSuccess(body, scope) {
  if (body?.code !== "200")
    throw new MarketDataError(
      "provider_response_error",
      `QWeather ${scope} request failed.`
    );
}

async function resolveLocation(input, dependencies = {}) {
  const coordinates = validateCoordinates(input?.lat, input?.lon);
  if (coordinates) {
    const locationId = `${coordinates.longitude.toFixed(6)},${coordinates.latitude.toFixed(6)}`;
    return {
      input_location: locationId,
      location: "gps",
      location_id: locationId,
      normalize_note: "已使用GPS经纬度查询天气",
    };
  }

  const normalized = normalizeLocation(input?.location);
  if (!normalized.query)
    throw new MarketDataError(
      "invalid_input",
      "location or lat/lon is required."
    );
  const cached = cacheGet(locationCache, normalized.query);
  if (cached)
    return {
      input_location: normalized.input,
      location: normalized.query,
      location_id: cached,
      normalize_note: normalized.note,
    };
  const body = await qweather(
    "/geo/v2/city/lookup",
    { location: normalized.query, range: "cn" },
    dependencies
  );
  assertQWeatherSuccess(body, "location");
  const locationId = body?.location?.[0]?.id;
  if (!locationId)
    throw new MarketDataError(
      "location_not_found",
      "Weather location not found."
    );
  cacheSet(locationCache, normalized.query, locationId, LOCATION_TTL_MS);
  return {
    input_location: normalized.input,
    location: normalized.query,
    location_id: locationId,
    normalize_note: normalized.note,
  };
}

function weatherBase(tool, resolved, cacheHit) {
  return {
    tool,
    ok: true,
    ...resolved,
    provider: "qweather",
    cache_hit: cacheHit,
    note: "Weather data may update with provider delay and is for reference only.",
    timestamp: new Date().toISOString(),
  };
}

async function executeWeatherCurrent(input, dependencies = {}) {
  const lang = optionalString(input, "lang", "zh");
  const unit = optionalString(input, "unit", "m");
  if (!["m", "i"].includes(unit))
    throw new MarketDataError("invalid_input", "Unsupported weather unit.");
  const resolved = await resolveLocation(input, dependencies);
  const cacheKey = `${resolved.location_id}:${lang}:${unit}`;
  const cached = cacheGet(currentCache, cacheKey);
  if (cached) return { ...cached, cache_hit: true };
  const body = await qweather(
    "/v7/weather/now",
    { location: resolved.location_id, lang, unit },
    dependencies
  );
  assertQWeatherSuccess(body, "current weather");
  const now = body?.now;
  if (!now)
    throw new MarketDataError(
      "provider_invalid_response",
      "QWeather returned no current conditions."
    );
  const output = {
    ...weatherBase("weather_current", resolved, false),
    temp: now.temp || null,
    feels_like: now.feelsLike || null,
    text: now.text || null,
    wind_dir: now.windDir || null,
    wind_scale: now.windScale || null,
    wind_speed: now.windSpeed || null,
    humidity: now.humidity || null,
    precip: now.precip || null,
    pressure: now.pressure || null,
    vis: now.vis || null,
    cloud: now.cloud || null,
    dew: now.dew || null,
    obs_time: now.obsTime || null,
    source: "qweather_now",
    freshness: "near_realtime",
  };
  cacheSet(currentCache, cacheKey, output, CURRENT_TTL_MS);
  return output;
}

function normalizeForecastDay(day = {}) {
  return {
    date: day.fxDate || null,
    sunrise: day.sunrise || null,
    sunset: day.sunset || null,
    moonrise: day.moonrise || null,
    moonset: day.moonset || null,
    moon_phase: day.moonPhase || null,
    temp_max: day.tempMax || null,
    temp_min: day.tempMin || null,
    text_day: day.textDay || null,
    text_night: day.textNight || null,
    wind_dir_day: day.windDirDay || null,
    wind_scale_day: day.windScaleDay || null,
    wind_speed_day: day.windSpeedDay || null,
    wind_dir_night: day.windDirNight || null,
    wind_scale_night: day.windScaleNight || null,
    wind_speed_night: day.windSpeedNight || null,
    humidity: day.humidity || null,
    precip: day.precip || null,
    pressure: day.pressure || null,
    vis: day.vis || null,
    cloud: day.cloud || null,
    uv_index: day.uvIndex || null,
  };
}

async function executeWeatherForecast(input, dependencies = {}) {
  const days = optionalString(input, "days", "3d");
  const lang = optionalString(input, "lang", "zh");
  const unit = optionalString(input, "unit", "m");
  if (!["3d", "7d", "10d", "15d", "30d"].includes(days))
    throw new MarketDataError("invalid_input", "Unsupported forecast days.");
  if (!["m", "i"].includes(unit))
    throw new MarketDataError("invalid_input", "Unsupported weather unit.");
  const resolved = await resolveLocation(input, dependencies);
  const today = new Date().toLocaleDateString("en-CA");
  const cacheKey = `${resolved.location_id}:${days}:${lang}:${unit}:${today}`;
  const cached = cacheGet(forecastCache, cacheKey);
  if (cached) return { ...cached, cache_hit: true };
  const body = await qweather(
    `/v7/weather/${days}`,
    { location: resolved.location_id, lang, unit },
    dependencies
  );
  assertQWeatherSuccess(body, "forecast");
  if (!Array.isArray(body?.daily))
    throw new MarketDataError(
      "provider_invalid_response",
      "QWeather returned no forecast."
    );
  const output = {
    ...weatherBase("weather_forecast", resolved, false),
    days,
    daily: body.daily.map(normalizeForecastDay),
    source: "qweather_forecast",
    freshness: "daily_forecast",
  };
  cacheSet(forecastCache, cacheKey, output, msUntilTomorrow());
  return output;
}

const locationProperties = {
  location: {
    type: "string",
    description: "City name, for example 上海 or 福州.",
  },
  lat: { type: "number", description: "Latitude; provide together with lon." },
  lon: { type: "number", description: "Longitude; provide together with lat." },
  lang: { type: "string", description: "Response language; defaults to zh." },
  unit: {
    type: "string",
    enum: ["m", "i"],
    description: "m=metric, i=imperial.",
  },
};

const weatherCurrent = jsonTool({
  name: "weather_current",
  description:
    "Query current weather by Chinese city name or GPS coordinates. Provinces are mapped to their capital cities. Location IDs are cached for 30 days and observations for 5 minutes.",
  examples: [
    {
      prompt: "上海现在天气怎么样？",
      call: JSON.stringify({ location: "上海" }),
    },
  ],
  parameters: {
    type: "object",
    properties: locationProperties,
    additionalProperties: false,
  },
  execute: executeWeatherCurrent,
});

const weatherForecast = jsonTool({
  name: "weather_forecast",
  description:
    "Query a 3, 7, 10, 15, or 30 day weather forecast by Chinese city name or GPS coordinates. Provinces are mapped to their capital cities.",
  examples: [
    {
      prompt: "上海未来三天天气",
      call: JSON.stringify({ location: "上海", days: "3d" }),
    },
  ],
  parameters: {
    type: "object",
    properties: {
      ...locationProperties,
      days: {
        type: "string",
        enum: ["3d", "7d", "10d", "15d", "30d"],
        description: "Forecast length; defaults to 3d.",
      },
    },
    additionalProperties: false,
  },
  execute: executeWeatherForecast,
});

const weatherAgent = {
  name: "weather-agent",
  startupConfig: { params: {} },
  plugin: [weatherCurrent, weatherForecast],
};

function clearWeatherCaches() {
  locationCache.clear();
  currentCache.clear();
  forecastCache.clear();
}

module.exports = {
  QWEATHER_API_HOST,
  clearWeatherCaches,
  executeWeatherCurrent,
  executeWeatherForecast,
  normalizeLocation,
  weatherAgent,
};
