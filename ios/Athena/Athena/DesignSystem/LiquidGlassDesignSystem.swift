import SwiftUI

enum AthenaSpacing {
    static let xs: CGFloat = 6
    static let sm: CGFloat = 10
    static let md: CGFloat = 16
    static let lg: CGFloat = 24
    static let xl: CGFloat = 32
}

enum AthenaRadius {
    static let sm: CGFloat = 8
    static let md: CGFloat = 14
    static let lg: CGFloat = 20
}

struct AthenaGlassModifier<S: Shape>: ViewModifier {
    let shape: S
    let interactive: Bool

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            if interactive {
                content.glassEffect(.regular.interactive(), in: shape)
            } else {
                content.glassEffect(.regular, in: shape)
            }
        } else {
            content.background(.ultraThinMaterial, in: shape)
        }
    }
}

extension View {
    func athenaGlass(interactive: Bool = false) -> some View {
        modifier(
            AthenaGlassModifier(
                shape: RoundedRectangle(cornerRadius: AthenaRadius.md, style: .continuous),
                interactive: interactive
            )
        )
    }

    func athenaGlass<S: Shape>(in shape: S, interactive: Bool = false) -> some View {
        modifier(AthenaGlassModifier(shape: shape, interactive: interactive))
    }

    @ViewBuilder
    func athenaGlassButton(prominent: Bool = false) -> some View {
        if #available(iOS 26.0, *) {
            if prominent {
                self.buttonStyle(.glassProminent)
            } else {
                self.buttonStyle(.glass)
            }
        } else {
            if prominent {
                self.buttonStyle(.borderedProminent)
            } else {
                self.buttonStyle(.bordered)
            }
        }
    }
}

struct AthenaGlassGroup<Content: View>: View {
    let spacing: CGFloat
    let content: Content

    init(spacing: CGFloat = AthenaSpacing.md, @ViewBuilder content: () -> Content) {
        self.spacing = spacing
        self.content = content()
    }

    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) {
                content
            }
        } else {
            content
        }
    }
}

struct AthenaScreenBackground: View {
    var body: some View {
        Color(.systemGroupedBackground)
            .ignoresSafeArea()
    }
}

struct AthenaScrollSurface<Content: View>: View {
    let spacing: CGFloat
    let content: Content

    init(spacing: CGFloat = AthenaSpacing.md, @ViewBuilder content: () -> Content) {
        self.spacing = spacing
        self.content = content()
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: spacing) {
                content
            }
            .padding(.horizontal, AthenaSpacing.md)
            .padding(.top, AthenaSpacing.sm)
            .padding(.bottom, AthenaSpacing.xl)
        }
        .background(AthenaScreenBackground())
        .scrollIndicators(.hidden)
    }
}

struct AthenaPanel<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .padding(AthenaSpacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .athenaGlass(interactive: false)
    }
}

struct AthenaIconTile: View {
    let systemImage: String
    let tint: Color

    var body: some View {
        Image(systemName: systemImage)
            .font(.title3.weight(.semibold))
            .foregroundStyle(tint)
            .frame(width: 38, height: 38)
            .athenaGlass(in: RoundedRectangle(cornerRadius: AthenaRadius.sm, style: .continuous))
    }
}

struct StatusPill: View {
    let title: String
    let systemImage: String
    let tint: Color

    var body: some View {
        Label {
            Text(title)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
                .truncationMode(.middle)
        } icon: {
            Image(systemName: systemImage)
        }
            .font(.caption.weight(.semibold))
            .padding(.horizontal, AthenaSpacing.sm)
            .padding(.vertical, AthenaSpacing.xs)
            .foregroundStyle(tint)
            .athenaGlass(in: Capsule(), interactive: false)
            .accessibilityLabel(title)
    }
}

struct SectionHeader: View {
    let title: String
    let subtitle: String?

    init(_ title: String, subtitle: String? = nil) {
        self.title = title
        self.subtitle = subtitle
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.headline)
            if let subtitle {
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct AthenaMetricRow: View {
    let title: String
    let value: String
    let systemImage: String
    let tint: Color

    var body: some View {
        HStack(spacing: AthenaSpacing.md) {
            AthenaIconTile(systemImage: systemImage, tint: tint)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(value)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: AthenaSpacing.sm)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
