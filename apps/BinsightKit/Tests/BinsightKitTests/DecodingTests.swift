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
    }
}
