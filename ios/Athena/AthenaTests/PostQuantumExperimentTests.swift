import CryptoKit
import XCTest
@testable import Athena

@available(iOS 26.0, *)
final class PostQuantumExperimentTests: XCTestCase {
    func testSoftwareCapabilityProbeExercisesStandardizedAndHybridAlgorithms() {
        let report = PostQuantumExperimentCenter.capabilityReport()

        XCTAssertTrue(report.mlDSA65)
        XCTAssertTrue(report.mlKEM768)
        XCTAssertTrue(report.xWing)
    }

    func testExperimentIsDisabledByDefaultAndCannotGrantProductionAccess() {
        unsetenv("ATHENA_IOS_PQ_EXPERIMENTS")

        XCTAssertThrowsError(
            try PostQuantumExperimentCenter.makeDeviceRegistrationExperiment(
                deviceId: "device-1",
                challenge: Data("challenge".utf8)
            )
        ) { error in
            XCTAssertEqual(
                error as? PostQuantumExperimentCenter.ExperimentError,
                .disabled
            )
        }
    }
}
