import assert from "node:assert/strict"
import test from "node:test"
import { parseWeatherIntent, WeatherCapability } from "../src/main/capabilities/weather.js"

test("weather intent parser extracts city and day without matching normal questions", () => {
  assert.deepEqual(parseWeatherIntent("明天深圳会下雨吗"), {
    location: "深圳",
    dayOffset: 1,
  })
  assert.deepEqual(parseWeatherIntent("今天天气怎样"), { dayOffset: 0 })
  assert.equal(parseWeatherIntent("这个项目用了什么框架"), null)
})

test("weather capability uses the default city and formats a deterministic answer", async () => {
  const previousFetch = globalThis.fetch
  const requestUrls: string[] = []
  try {
    globalThis.fetch = async (input) => {
      const url = String(input)
      requestUrls.push(url)
      if (url.startsWith("https://geocoding-api.open-meteo.com/")) {
        const isShenzhen = url.includes("name=%E6%B7%B1%E5%9C%B3")
        return new Response(
          JSON.stringify({
            results: [
              {
                name: isShenzhen ? "深圳" : "上海",
                latitude: isShenzhen ? 22.54 : 31.23,
                longitude: isShenzhen ? 114.06 : 121.47,
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(
        JSON.stringify({
          current: {
            temperature_2m: 29.2,
            apparent_temperature: 32.6,
            wind_speed_10m: 11.7,
          },
          daily: {
            time: ["2026-08-06", "2026-08-07"],
            weather_code: [2, 3],
            temperature_2m_max: [34.4, 33.1],
            temperature_2m_min: [27.1, 26.8],
            precipitation_probability_max: [40, 60],
          },
        }),
        { status: 200 },
      )
    }

    const events: Array<{ type: string; content?: string }> = []
    await new WeatherCapability().stream({ dayOffset: 0 }, "上海", (event) => {
      events.push(event)
    })

    assert.deepEqual(events, [
      { type: "start" },
      {
        type: "chunk",
        content:
          "上海今天局部多云，当前 29.2°C，体感 32.6°C；最高 34.4°C / 最低 27.1°C，降雨概率 40%，风速 11.7 km/h。",
      },
      { type: "done" },
    ])
    assert.equal(requestUrls.length, 2)
    assert.match(requestUrls[0], /name=%E4%B8%8A%E6%B5%B7/)
    assert.match(requestUrls[1], /latitude=31.23/)

    await new WeatherCapability().stream({ location: "深圳", dayOffset: 1 }, "上海", () => {})
    assert.match(requestUrls[2], /name=%E6%B7%B1%E5%9C%B3/)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("weather capability asks for a city and handles unknown locations predictably", async () => {
  const previousFetch = globalThis.fetch
  let fetchCount = 0
  try {
    globalThis.fetch = async () => {
      fetchCount += 1
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    }

    const noLocationEvents: Array<{ type: string; content?: string }> = []
    await new WeatherCapability().stream({ dayOffset: 0 }, "", (event) => {
      noLocationEvents.push(event)
    })
    assert.equal(fetchCount, 0)
    assert.equal(noLocationEvents[1]?.content, "你想查哪个城市？也可以在设置中保存默认城市。")

    const unknownLocationEvents: Array<{ type: string; content?: string }> = []
    await new WeatherCapability().stream(
      { location: "不存在市", dayOffset: 0 },
      "上海",
      (event) => {
        unknownLocationEvents.push(event)
      },
    )
    assert.equal(
      unknownLocationEvents[1]?.content,
      "没有找到“不存在市”，请换成城市名，例如上海或深圳。",
    )
  } finally {
    globalThis.fetch = previousFetch
  }
})
