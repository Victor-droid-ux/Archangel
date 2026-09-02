jest.mock("axios", () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

import axios from "axios";
import birdeyeService from "../services/birdeye.service.js";

const mockedGet = axios.get as jest.Mock;

describe("Birdeye market-health availability", () => {
  beforeEach(() => {
    mockedGet.mockReset();
  });

  it("defers market health when Birdeye compute units are exhausted", async () => {
    mockedGet.mockRejectedValue({
      message: "Request failed with status code 400",
      response: {
        status: 400,
        data: { success: false, message: "Compute units usage limit exceeded" },
      },
    });

    const result = await birdeyeService.checkMarketHealth("MINT", 0.05);

    expect(result.isHealthy).toBe(true);
    expect(result.deferred).toBe(true);
    expect(result.reasons[0]).toContain("quota/rate limit unavailable");
  });

  it("still rejects ordinary Birdeye API failures", async () => {
    mockedGet.mockRejectedValue({
      message: "Request failed with status code 401",
      response: { status: 401, data: { message: "Unauthorized" } },
    });

    const result = await birdeyeService.checkMarketHealth("MINT", 0.05);

    expect(result.isHealthy).toBe(false);
    expect(result.deferred).toBeUndefined();
  });
});
