import SwiftUI

/// Wallets editor (macOS Settings). Lists monitored wallets
/// with delete + an add row, validates the address client-side, and surfaces API errors.
/// `onChange` lets the host resync after a change.
public struct WalletsEditor: View {
    private let onChange: () -> Void
    @State private var wallets: [WalletInfo] = []
    @State private var newAddress = ""
    @State private var newLabel = ""
    @State private var busy = false
    @State private var error: String?

    public init(onChange: @escaping () -> Void = {}) { self.onChange = onChange }

    private var addressValid: Bool { SolanaAddress.isValid(newAddress) }

    public var body: some View {
        Group {
            if wallets.isEmpty {
                Text("No wallets yet — add one below").font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
            ForEach(wallets) { w in
                HStack {
                    VStack(alignment: .leading, spacing: 1) {
                        if !w.label.isEmpty {
                            Text(w.label).font(.system(size: 13, weight: .medium))
                        }
                        Text(short(w.address)).font(.system(size: 11).monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button(role: .destructive) {
                        Task { await remove(w.address) }
                    } label: {
                        Image(systemName: "trash").foregroundStyle(.red)
                    }
                    .buttonStyle(.borderless)
                    .disabled(busy)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                TextField("Solana wallet address", text: $newAddress).plainInput()
                TextField("Label (optional)", text: $newLabel).plainInput()
                if let error {
                    Text(error).font(.system(size: 11)).foregroundStyle(.red)
                }
                Button("Add wallet") { Task { await add() } }
                    .disabled(busy || !addressValid)
            }
        }
        .task { await load() }
    }

    @MainActor private func load() async { wallets = await Backend.wallets() }

    @MainActor private func add() async {
        busy = true
        error = nil
        switch await Backend.addWallet(
            address: newAddress.trimmingCharacters(in: .whitespaces), label: newLabel)
        {
        case .ok:
            newAddress = ""
            newLabel = ""
            await load()
            onChange()
        case .unauthorized:
            error = "Unauthorized — check your password in Settings."
        case .failed:
            error = "Couldn't add the wallet — check the address."
        }
        busy = false
    }

    @MainActor private func remove(_ address: String) async {
        busy = true
        error = nil
        switch await Backend.removeWallet(address: address) {
        case .ok:
            await load()
            onChange()
        case .unauthorized:
            error = "Unauthorized — check your password in Settings."
        case .failed:
            error = "Couldn't remove the wallet."
        }
        busy = false
    }

}

extension View {
    /// No autocorrect for address-style fields.
    fileprivate func plainInput() -> some View {
        autocorrectionDisabled()
    }
}
