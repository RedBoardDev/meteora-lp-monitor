import XCTest
@testable import MeteoraLPMonitorKit

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
