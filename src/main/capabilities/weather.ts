import type { ChatStreamEvent } from "../../shared/types.js"

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
const REQUEST_TIMEOUT_MS = 5_000

const WEATHER_INTENT_PATTERN = /天气|气温|温度|下雨|降雨|下雪|降雪|雷雨|晴不晴|冷不冷|热不热|穿什么/

export interface WeatherIntent {
  location?: string
  dayOffset: 0 | 1 | 2
}

interface WeatherLocation {
  name: string
  latitude: number
  longitude: number
}

interface WeatherDay {
  date: string
  weatherCode: number
  maximumTemperature: number
  minimumTemperature: number
  precipitationProbability: number
}

interface CurrentWeather {
  temperature: number
  apparentTemperature: number
  windSpeed: number
}

interface WeatherForecast {
  current?: CurrentWeather
  day: WeatherDay
}

class LocationNotFoundError extends Error {}

export function parseWeatherIntent(content: string): WeatherIntent | null {
  const normalized = content.trim()
  if (!normalized || !WEATHER_INTENT_PATTERN.test(normalized)) return null

  const dayOffset: WeatherIntent["dayOffset"] = /后天/.test(normalized)
    ? 2
    : /明天|明日/.test(normalized)
      ? 1
      : 0
  const location = extractLocation(normalized)
  return { dayOffset, ...(location ? { location } : {}) }
}

export class WeatherCapability {
  private activeRequest: AbortController | null = null

  cancel(): void {
    this.activeRequest?.abort()
    this.activeRequest = null
  }

  async stream(
    intent: WeatherIntent,
    defaultLocation: string,
    emit: (event: ChatStreamEvent) => void,
  ): Promise<void> {
    this.cancel()
    const controller = new AbortController()
    this.activeRequest = controller
    emit({ type: "start" })

    try {
      const content = await getWeatherAnswer(intent, defaultLocation, controller.signal)
      if (controller.signal.aborted) {
        emit({ type: "cancelled" })
        return
      }
      emit({ type: "chunk", content })
      emit({ type: "done" })
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        if (this.activeRequest === controller) emit({ type: "cancelled" })
      } else {
        emit({ type: "error", message: "天气查询失败，请稍后重试。" })
      }
    } finally {
      if (this.activeRequest === controller) this.activeRequest = null
    }
  }
}

async function getWeatherAnswer(
  intent: WeatherIntent,
  defaultLocation: string,
  signal: AbortSignal,
): Promise<string> {
  const locationQuery = intent.location?.trim() || defaultLocation.trim()
  if (!locationQuery) return "你想查哪个城市？也可以在设置中保存默认城市。"

  try {
    const location = await geocodeLocation(locationQuery, signal)
    const forecast = await fetchForecast(location, intent.dayOffset, signal)
    return formatWeatherAnswer(location.name, intent.dayOffset, forecast)
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw error
    if (error instanceof LocationNotFoundError) {
      return `没有找到“${locationQuery}”，请换成城市名，例如上海或深圳。`
    }
    return "天气服务暂时不可用，请稍后重试。"
  }
}

async function geocodeLocation(query: string, signal: AbortSignal): Promise<WeatherLocation> {
  const url = new URL(GEOCODING_URL)
  url.searchParams.set("name", query)
  url.searchParams.set("count", "1")
  url.searchParams.set("language", "zh")
  url.searchParams.set("format", "json")

  const value = await fetchJson(url, signal)
  if (!isRecord(value) || !Array.isArray(value.results) || value.results.length === 0) {
    throw new LocationNotFoundError(query)
  }

  const result = value.results[0]
  if (!isRecord(result)) throw new LocationNotFoundError(query)
  const name = result.name
  const latitude = result.latitude
  const longitude = result.longitude
  if (
    typeof name !== "string" ||
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude)
  ) {
    throw new LocationNotFoundError(query)
  }

  return { name, latitude, longitude }
}

async function fetchForecast(
  location: WeatherLocation,
  dayOffset: WeatherIntent["dayOffset"],
  signal: AbortSignal,
): Promise<WeatherForecast> {
  const url = new URL(FORECAST_URL)
  url.searchParams.set("latitude", String(location.latitude))
  url.searchParams.set("longitude", String(location.longitude))
  url.searchParams.set("current", "temperature_2m,apparent_temperature,weather_code,wind_speed_10m")
  url.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
  )
  url.searchParams.set("timezone", "auto")
  url.searchParams.set("forecast_days", String(dayOffset + 1))

  const value = await fetchJson(url, signal)
  if (!isRecord(value) || !isRecord(value.daily)) throw new Error("天气预报格式无效")

  const daily = value.daily
  const date = getNumberOrString(daily.time, dayOffset, "date")
  const weatherCode = getNumber(daily.weather_code, dayOffset, "weatherCode")
  const maximumTemperature = getNumber(daily.temperature_2m_max, dayOffset, "maximumTemperature")
  const minimumTemperature = getNumber(daily.temperature_2m_min, dayOffset, "minimumTemperature")
  const precipitationProbability = getNumber(
    daily.precipitation_probability_max,
    dayOffset,
    "precipitationProbability",
  )

  let current: CurrentWeather | undefined
  if (dayOffset === 0 && isRecord(value.current)) {
    const temperature = value.current.temperature_2m
    const apparentTemperature = value.current.apparent_temperature
    const windSpeed = value.current.wind_speed_10m
    if (
      typeof temperature === "number" &&
      typeof apparentTemperature === "number" &&
      typeof windSpeed === "number"
    ) {
      current = { temperature, apparentTemperature, windSpeed }
    }
  }

  return {
    current,
    day: {
      date,
      weatherCode,
      maximumTemperature,
      minimumTemperature,
      precipitationProbability,
    },
  }
}

function formatWeatherAnswer(
  locationName: string,
  dayOffset: WeatherIntent["dayOffset"],
  forecast: WeatherForecast,
): string {
  const dayLabel = dayOffset === 0 ? "今天" : dayOffset === 1 ? "明天" : "后天"
  const condition = describeWeatherCode(forecast.day.weatherCode)
  const temperature = `最高 ${formatNumber(forecast.day.maximumTemperature)}°C / 最低 ${formatNumber(forecast.day.minimumTemperature)}°C`
  const precipitation = `降雨概率 ${formatNumber(forecast.day.precipitationProbability)}%`

  if (dayOffset === 0 && forecast.current) {
    return `${locationName}${dayLabel}${condition}，当前 ${formatNumber(forecast.current.temperature)}°C，体感 ${formatNumber(forecast.current.apparentTemperature)}°C；${temperature}，${precipitation}，风速 ${formatNumber(forecast.current.windSpeed)} km/h。`
  }
  return `${locationName}${dayLabel}${condition}；${temperature}，${precipitation}。`
}

function extractLocation(content: string): string | undefined {
  const location = content
    .replace(/^(请问|请|帮我|帮忙|告诉我|查询|查一下|看一下|想知道|我想知道|我想查)/g, " ")
    .replace(
      /后天|明天|明日|今天|今日|现在|当前|天气预报|天气|气温|温度|降雨概率|降雨|下雨|降雪|下雪|雷雨|晴不晴|冷不冷|热不热|穿什么|会不会|会|有无|有没有|如何|怎样|怎么样|多少|吗|呢|吧|的/g,
      " ",
    )
    .replace(/[，。！？?!：:、,.]/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  return location.length > 0 && location.length <= 64 ? location : undefined
}

async function fetchJson(url: URL, parentSignal: AbortSignal): Promise<unknown> {
  if (parentSignal.aborted) {
    const error = new Error("天气请求已取消")
    error.name = "AbortError"
    throw error
  }

  const controller = new AbortController()
  let timedOut = false
  const abortFromParent = () => controller.abort()
  parentSignal.addEventListener("abort", abortFromParent, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`天气服务返回 ${response.status}`)
    return await response.json()
  } catch (error) {
    if (parentSignal.aborted) throw error
    if (timedOut) throw new Error("天气服务请求超时")
    throw error
  } finally {
    clearTimeout(timer)
    parentSignal.removeEventListener("abort", abortFromParent)
  }
}

function getNumberOrString(value: unknown, index: number, name: string): string {
  if (!Array.isArray(value) || typeof value[index] !== "string") {
    throw new Error(`天气预报缺少 ${name}`)
  }
  return value[index]
}

function getNumber(value: unknown, index: number, name: string): number {
  if (!Array.isArray(value) || typeof value[index] !== "number" || !Number.isFinite(value[index])) {
    throw new Error(`天气预报缺少 ${name}`)
  }
  return value[index]
}

function describeWeatherCode(code: number): string {
  if (code === 0) return "晴"
  if (code === 1) return "基本晴朗"
  if (code === 2) return "局部多云"
  if (code === 3) return "阴"
  if (code === 45 || code === 48) return "有雾"
  if (code >= 51 && code <= 57) return "有毛毛雨"
  if (code >= 61 && code <= 67) return "有雨"
  if (code >= 71 && code <= 77) return "有雪"
  if (code >= 80 && code <= 82) return "有阵雨"
  if (code === 85 || code === 86) return "有阵雪"
  if (code >= 95) return "有雷雨"
  return "天气多变"
}

function formatNumber(value: number): string {
  return String(Math.round(value * 10) / 10)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}
