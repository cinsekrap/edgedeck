// Draws EdgeDeck's app icon and writes Resources/AppIcon.icns.
// Run from the repo root:  swift tools/make-icon.swift
// The design: a dark macOS-style rounded square holding the Xeneon Edge as a wide
// glowing bar of tiles (the menu bar symbol, rectangle.split.3x1, made physical).
import AppKit

func color(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: a)
}

func gradient(_ colors: [CGColor], _ locations: [CGFloat]) -> CGGradient {
    CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors as CFArray, locations: locations)!
}

func draw(size: Int) -> Data {
    let s = CGFloat(size) / 1024
    let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.scaleBy(x: s, y: s)
    // CoreGraphics' origin is bottom-left; work top-down like the design grid.
    ctx.translateBy(x: 0, y: 1024)
    ctx.scaleBy(x: 1, y: -1)

    // Base shape: Apple's 824 pt rounded square on a 1024 canvas, with its shadow.
    let base = CGRect(x: 100, y: 100, width: 824, height: 824)
    let basePath = CGPath(roundedRect: base, cornerWidth: 185, cornerHeight: 185, transform: nil)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: 12), blur: 28, color: color(0x000000, 0.35))
    ctx.addPath(basePath)
    ctx.setFillColor(color(0x2b313b))
    ctx.fillPath()
    ctx.restoreGState()

    ctx.saveGState()
    ctx.addPath(basePath)
    ctx.clip()
    ctx.drawLinearGradient(gradient([color(0x56606f), color(0x2b313b)], [0, 1]),
                           start: CGPoint(x: 512, y: 100), end: CGPoint(x: 512, y: 924), options: [])
    // Soft blue glow from the screen onto the "desk" below it.
    ctx.drawRadialGradient(gradient([color(0x4cc2ff, 0.22), color(0x4cc2ff, 0)], [0, 1]),
                           startCenter: CGPoint(x: 512, y: 560), startRadius: 0,
                           endCenter: CGPoint(x: 512, y: 560), endRadius: 430, options: [])
    ctx.restoreGState()
    // Hairline rim so it holds its shape on dark backgrounds.
    ctx.addPath(CGPath(roundedRect: base.insetBy(dx: 1.5, dy: 1.5), cornerWidth: 184, cornerHeight: 184, transform: nil))
    ctx.setStrokeColor(color(0xffffff, 0.10))
    ctx.setLineWidth(3)
    ctx.strokePath()

    // The Edge: a 32:9 panel in a slim bezel, on a small foot.
    let panel = CGRect(x: 172, y: 372, width: 680, height: 220)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: 18), blur: 36, color: color(0x000000, 0.55))
    ctx.addPath(CGPath(roundedRect: panel, cornerWidth: 34, cornerHeight: 34, transform: nil))
    ctx.setFillColor(color(0x040506))
    ctx.fillPath()
    ctx.restoreGState()
    ctx.addPath(CGPath(roundedRect: panel.insetBy(dx: 1.5, dy: 1.5), cornerWidth: 33, cornerHeight: 33, transform: nil))
    ctx.setStrokeColor(color(0x3a414d))
    ctx.setLineWidth(3)
    ctx.strokePath()

    let foot = CGMutablePath()
    foot.move(to: CGPoint(x: 462, y: panel.maxY))
    foot.addLine(to: CGPoint(x: 562, y: panel.maxY))
    foot.addLine(to: CGPoint(x: 592, y: panel.maxY + 62))
    foot.addLine(to: CGPoint(x: 432, y: panel.maxY + 62))
    foot.closeSubpath()
    ctx.addPath(foot)
    ctx.setFillColor(color(0x1b1f26))
    ctx.fillPath()
    ctx.addPath(CGPath(roundedRect: CGRect(x: 392, y: panel.maxY + 56, width: 240, height: 22),
                       cornerWidth: 11, cornerHeight: 11, transform: nil))
    ctx.setFillColor(color(0x2a3039))
    ctx.fillPath()

    // Three tiles on the screen: one lit, two quieter ones with content hints.
    let screen = panel.insetBy(dx: 26, dy: 26)
    let gap: CGFloat = 20
    let w = (screen.width - gap * 2) / 3
    for i in 0..<3 {
        let r = CGRect(x: screen.minX + CGFloat(i) * (w + gap), y: screen.minY, width: w, height: screen.height)
        let p = CGPath(roundedRect: r, cornerWidth: 18, cornerHeight: 18, transform: nil)
        ctx.saveGState()
        if i == 0 {
            ctx.setShadow(offset: .zero, blur: 40, color: color(0x4cc2ff, 0.9))
            ctx.addPath(p)
            ctx.setFillColor(color(0x4cc2ff))
            ctx.fillPath()
            ctx.restoreGState()
            ctx.saveGState()
            ctx.addPath(p)
            ctx.clip()
            ctx.drawLinearGradient(gradient([color(0x8fdcff), color(0x2a9ff0)], [0, 1]),
                                   start: CGPoint(x: r.midX, y: r.minY), end: CGPoint(x: r.midX, y: r.maxY), options: [])
        } else {
            ctx.addPath(p)
            ctx.setFillColor(color(0x1a1e25))
            ctx.fillPath()
        }
        ctx.restoreGState()
        if i == 1 {
            // A media-style progress bar.
            ctx.addPath(CGPath(roundedRect: CGRect(x: r.minX + 26, y: r.midY - 7, width: r.width - 52, height: 14),
                               cornerWidth: 7, cornerHeight: 7, transform: nil))
            ctx.setFillColor(color(0x2e3440))
            ctx.fillPath()
            ctx.addPath(CGPath(roundedRect: CGRect(x: r.minX + 26, y: r.midY - 7, width: (r.width - 52) * 0.6, height: 14),
                               cornerWidth: 7, cornerHeight: 7, transform: nil))
            ctx.setFillColor(color(0x4cc2ff, 0.85))
            ctx.fillPath()
        } else if i == 2 {
            // Stats-style bars.
            let heights: [CGFloat] = [0.45, 0.75, 0.55, 0.9]
            let bw: CGFloat = 22, total = bw * 4 + 16 * 3
            for (j, f) in heights.enumerated() {
                let h = (r.height - 64) * f
                let x = r.midX - total / 2 + CGFloat(j) * (bw + 16)
                ctx.addPath(CGPath(roundedRect: CGRect(x: x, y: r.maxY - 32 - h, width: bw, height: h),
                                   cornerWidth: 6, cornerHeight: 6, transform: nil))
                ctx.setFillColor(color(j == 3 ? 0x4cc2ff : 0x3a4250, j == 3 ? 0.85 : 1))
                ctx.fillPath()
            }
        }
    }
    // Glass sheen across the top of the screen.
    ctx.saveGState()
    ctx.addPath(CGPath(roundedRect: panel.insetBy(dx: 3, dy: 3), cornerWidth: 31, cornerHeight: 31, transform: nil))
    ctx.clip()
    ctx.drawLinearGradient(gradient([color(0xffffff, 0.10), color(0xffffff, 0)], [0, 1]),
                           start: CGPoint(x: 512, y: panel.minY), end: CGPoint(x: 512, y: panel.midY), options: [])
    ctx.restoreGState()

    let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
    return rep.representation(using: .png, properties: [:])!
}

let fm = FileManager.default
let iconset = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("AppIcon.iconset")
try? fm.removeItem(at: iconset)
try! fm.createDirectory(at: iconset, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
    try! draw(size: base).write(to: iconset.appendingPathComponent("icon_\(base)x\(base).png"))
    try! draw(size: base * 2).write(to: iconset.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}
try! draw(size: 1024).write(to: URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon-preview.png"))

let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
p.arguments = ["-c", "icns", iconset.path, "-o", "Resources/AppIcon.icns"]
try! p.run()
p.waitUntilExit()
print(p.terminationStatus == 0 ? "Wrote Resources/AppIcon.icns" : "iconutil failed")
