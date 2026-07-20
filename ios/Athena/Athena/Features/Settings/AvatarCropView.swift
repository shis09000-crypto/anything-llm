import SwiftUI
import UIKit

struct AvatarCropSource: Identifiable {
    let id = UUID()
    let image: UIImage

    init(image: UIImage) {
        self.image = image.normalizedForCropping()
    }
}

struct AvatarCropView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppDependencies.self) private var dependencies

    let source: AvatarCropSource

    @State private var exportRequestID = 0
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                let cropSize = min(geometry.size.width - 48, 360)

                VStack(spacing: 28) {
                    Spacer(minLength: 24)

                    AvatarCropViewport(
                        image: source.image,
                        exportRequestID: exportRequestID,
                        onExport: save
                    )
                    .frame(width: cropSize, height: cropSize)
                    .clipShape(Circle())
                    .overlay {
                        Circle()
                            .stroke(.white.opacity(0.82), lineWidth: 1)
                            .allowsHitTesting(false)
                    }
                    .overlay {
                        if isSaving {
                            ProgressView()
                                .controlSize(.large)
                                .padding(22)
                                .background(.regularMaterial, in: Circle())
                        }
                    }

                    Text("拖动并缩放图片，使头像位于圆形区域内")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)

                    Spacer(minLength: 24)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.horizontal, 24)
            }
            .navigationTitle("调整头像")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消", systemImage: "xmark") {
                        dismiss()
                    }
                    .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成", systemImage: "checkmark") {
                        isSaving = true
                        exportRequestID &+= 1
                    }
                    .disabled(isSaving)
                }
            }
        }
        .interactiveDismissDisabled(isSaving)
        .alert("无法更新头像", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("好", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "请稍后重试。")
        }
    }

    private func save(_ croppedImage: UIImage?) {
        Task { @MainActor in
            guard let croppedImage,
                  let jpeg = croppedImage.jpegData(compressionQuality: 0.95) else {
                isSaving = false
                errorMessage = "无法生成头像图片。"
                return
            }
            do {
                try await dependencies.accountProfileCenter.uploadAvatar(jpeg)
                dismiss()
            } catch {
                isSaving = false
                errorMessage = error.localizedDescription
            }
        }
    }
}

private struct AvatarCropViewport: UIViewRepresentable {
    let image: UIImage
    let exportRequestID: Int
    let onExport: (UIImage?) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> AvatarCropViewportView {
        let view = AvatarCropViewportView()
        view.setImage(image)
        return view
    }

    func updateUIView(_ uiView: AvatarCropViewportView, context: Context) {
        uiView.setImage(image)
        guard exportRequestID != context.coordinator.lastExportRequestID else {
            return
        }
        context.coordinator.lastExportRequestID = exportRequestID
        guard exportRequestID > 0 else {
            return
        }
        onExport(uiView.croppedImage())
    }

    final class Coordinator {
        var lastExportRequestID = 0
    }
}

private final class AvatarCropViewportView: UIView, UIScrollViewDelegate {
    private let scrollView = UIScrollView()
    private let imageView = UIImageView()
    private var sourceImage: UIImage?
    private var configuredBounds: CGSize = .zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        backgroundColor = .secondarySystemBackground

        scrollView.delegate = self
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.bounces = true
        scrollView.bouncesZoom = true
        scrollView.decelerationRate = .fast
        scrollView.contentInsetAdjustmentBehavior = .never
        addSubview(scrollView)

        imageView.contentMode = .scaleAspectFit
        scrollView.addSubview(imageView)
    }

    required init?(coder: NSCoder) {
        nil
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        scrollView.frame = bounds
        guard bounds.size != .zero,
              bounds.size != configuredBounds,
              let sourceImage else {
            return
        }
        configuredBounds = bounds.size
        configure(image: sourceImage)
    }

    func setImage(_ image: UIImage) {
        guard sourceImage !== image else { return }
        sourceImage = image
        imageView.image = image
        configuredBounds = .zero
        setNeedsLayout()
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? {
        imageView
    }

    func croppedImage() -> UIImage? {
        guard let sourceImage,
              let cgImage = sourceImage.cgImage,
              scrollView.zoomScale > 0 else {
            return nil
        }
        let pixelRect = AvatarCropGeometry.pixelCropRect(
            viewportSize: bounds.size,
            contentOffset: scrollView.contentOffset,
            zoomScale: scrollView.zoomScale,
            imagePointSize: imageView.bounds.size,
            imagePixelSize: CGSize(width: cgImage.width, height: cgImage.height)
        )
        guard pixelRect.width > 0,
              pixelRect.height > 0,
              let cropped = cgImage.cropping(to: pixelRect) else {
            return nil
        }
        return UIImage(cgImage: cropped, scale: 1, orientation: .up)
    }

    private func configure(image: UIImage) {
        imageView.frame = CGRect(origin: .zero, size: image.size)
        scrollView.contentSize = image.size
        let minimumScale = max(
            bounds.width / max(image.size.width, 1),
            bounds.height / max(image.size.height, 1)
        )
        scrollView.minimumZoomScale = minimumScale
        scrollView.maximumZoomScale = max(minimumScale * 6, minimumScale + 1)
        scrollView.zoomScale = minimumScale
        let contentSize = CGSize(
            width: image.size.width * minimumScale,
            height: image.size.height * minimumScale
        )
        scrollView.contentOffset = CGPoint(
            x: max((contentSize.width - bounds.width) / 2, 0),
            y: max((contentSize.height - bounds.height) / 2, 0)
        )
    }
}

enum AvatarCropGeometry {
    static func pixelCropRect(
        viewportSize: CGSize,
        contentOffset: CGPoint,
        zoomScale: CGFloat,
        imagePointSize: CGSize,
        imagePixelSize: CGSize
    ) -> CGRect {
        guard zoomScale > 0,
              imagePointSize.width > 0,
              imagePointSize.height > 0,
              imagePixelSize.width > 0,
              imagePixelSize.height > 0 else {
            return .null
        }
        let visibleInPoints = CGRect(
            x: contentOffset.x / zoomScale,
            y: contentOffset.y / zoomScale,
            width: viewportSize.width / zoomScale,
            height: viewportSize.height / zoomScale
        )
        let pixelScaleX = imagePixelSize.width / imagePointSize.width
        let pixelScaleY = imagePixelSize.height / imagePointSize.height
        let proposed = CGRect(
            x: visibleInPoints.minX * pixelScaleX,
            y: visibleInPoints.minY * pixelScaleY,
            width: visibleInPoints.width * pixelScaleX,
            height: visibleInPoints.height * pixelScaleY
        ).integral
        return proposed.intersection(CGRect(origin: .zero, size: imagePixelSize))
    }
}

extension UIImage {
    func normalizedForCropping() -> UIImage {
        guard imageOrientation != .up else { return self }
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = scale
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            draw(in: CGRect(origin: .zero, size: size))
        }
    }
}
