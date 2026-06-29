import XCTest
@testable import BinsightKit

final class DecodingTests: XCTestCase {
    func testStatePayloadDecodes() throws {
        let json = """
        {"type":"state","payload":{"scope":"all","totals":{"uPnlSol":1.5,"uPnlPct":2.0,
        "feesSol":0.1,"claimedFeesSol":0.05,"unclaimedFeesSol":0.05,"tvlSol":10,"idleSol":7.5,
        "walletTotalSol":17.5,"openCount":2,"inRangeCount":1,"outOfRangeCount":1},
        "openPositions":[]}}
        """
        let msg = try ServerMessage(from: Data(json.utf8))
        guard case .state(let s) = msg else { return XCTFail("expected .state") }
        XCTAssertEqual(s.scope, "all")
        XCTAssertEqual(s.totals.walletTotalSol, 17.5)
        XCTAssertEqual(s.totals.idleSol, 7.5)
    }

    func testHealthDecodes() throws {
        let json = """
        {"type":"health","payload":{"ok":true,"wsConnected":true,"meteoraOk":false,
        "effectiveRps":2,"wallets":[],"uptimeSeconds":10}}
        """
        let msg = try ServerMessage(from: Data(json.utf8))
        guard case .health(let h) = msg else { return XCTFail("expected .health") }
        XCTAssertTrue(h.wsConnected)
        XCTAssertFalse(h.meteoraOk)
    }

    func testHealthDecodesPerSourceDetail() throws {
        let json = """
        {"type":"health","payload":{"ok":false,"wsConnected":true,"meteoraOk":true,
        "effectiveRps":1,"chainTipSlot":426199021,
        "sources":[{"name":"rpc","status":"down","lastOkAt":1,"lastErrorAt":2,"consecutiveErrors":3,"detail":"RPC 429"},
                   {"name":"jupiter","status":"ok","lastOkAt":5,"lastErrorAt":null,"consecutiveErrors":0,"detail":null}],
        "wallets":[],"uptimeSeconds":10}}
        """
        let msg = try ServerMessage(from: Data(json.utf8))
        guard case .health(let h) = msg else { return XCTFail("expected .health") }
        XCTAssertEqual(h.chainTipSlot, 426199021)
        XCTAssertEqual(h.sources?.count, 2)
        XCTAssertEqual(h.sources?.first?.name, "rpc")
        XCTAssertEqual(h.sources?.first?.status, "down")
        XCTAssertEqual(h.sources?.first?.detail, "RPC 429")
    }

    func testUnknownTypeIsOther() throws {
        let msg = try ServerMessage(from: Data(#"{"type":"ping","payload":{}}"#.utf8))
        guard case .other = msg else { return XCTFail("expected .other") }
    }

    func testFormatters() {
        XCTAssertEqual(signed(1.2345), "+1.2345")
        XCTAssertEqual(signed(-0.5), "-0.5000")
        XCTAssertEqual(pct2(-3.14159), "-3.14%")
        XCTAssertEqual(pctOf(0, 0), "—")
        // 2-dp size formatter used by the closed-row resting summary.
        XCTAssertEqual(abs2(2.4131), "2.41")
        XCTAssertEqual(abs2(-2.4181), "2.42")
    }

    // WHY: the panel keeps relative ages fresh by feeding `ageString` a clock from a periodic timeline.
    // A fixed `now` proves the output is driven by the injected clock (not the wall clock) and that the
    // minute/hour/day bucketing is correct — a revert to an internal `Date()` would fail these.
    func testAgeStringHonorsInjectedClock() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let msAgo: (Double) -> Double = { (1_000_000 - $0) * 1000 } // epoch-ms `secs` before `now`
        XCTAssertEqual(ageString(msAgo(300), now: now), "5m")     // 5 min  → minutes bucket
        XCTAssertEqual(ageString(msAgo(5400), now: now), "1h")    // 90 min → hours bucket (floored)
        XCTAssertEqual(ageString(msAgo(172_800), now: now), "2d") // 2 days → days bucket
        XCTAssertEqual(ageString(nil, now: now), "—")
        XCTAssertEqual(ageString(0, now: now), "—")
    }

    // WHY: the "open in Binsight" quick-link must target the WEB origin (api. host prefix dropped), not
    // the API origin; a non-standard host (localhost dev API) falls back to the live production site.
    func testWebURLDerivation() {
        XCTAssertEqual(Config.webURL(fromAPI: "https://api.binsight.thomasott.fr"), "https://binsight.thomasott.fr")
        XCTAssertEqual(Config.webURL(fromAPI: "https://api.staging.example.com"), "https://staging.example.com")
        XCTAssertEqual(Config.webURL(fromAPI: "http://localhost:8787"), Config.prodWebURL)
        XCTAssertEqual(Config.webURL(fromAPI: "not a url"), Config.prodWebURL)
    }

    // WHY: the closed-row shows a strategy badge; the model must decode the wire's `strategy` and also
    // tolerate its absence (historical closes the server never observed open carry no strategy → nil).
    func testClosedPositionDecodesStrategy() throws {
        let withStrategy = """
        {"positionAddress":"P","wallet":"W","tokenX":"BONK","tokenY":"SOL","tokenXMint":"M",
         "pnlSol":0.5,"pnlPctSol":1.2,"feesSol":0.1,"depositSol":2.41,"closedAt":123,"strategy":"Curve"}
        """
        let c = try JSONDecoder().decode(ClosedPosition.self, from: Data(withStrategy.utf8))
        XCTAssertEqual(c.strategy, .curve)
        XCTAssertEqual(c.depositSol, 2.41)

        let noStrategy = """
        {"positionAddress":"P","wallet":"W","tokenX":"BONK","tokenY":"SOL","tokenXMint":"M",
         "pnlSol":0.5,"pnlPctSol":1.2,"feesSol":0.1,"depositSol":2.41,"closedAt":123}
        """
        let c2 = try JSONDecoder().decode(ClosedPosition.self, from: Data(noStrategy.utf8))
        XCTAssertNil(c2.strategy)
    }
}
