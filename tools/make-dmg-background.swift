// Draws the DMG window background (640x400 pt, @1x and @2x) and writes
// Resources/dmg-background.tiff. Run from the repo root:
//   swift tools/make-dmg-background.swift
// Layout matches make-dmg.sh: app icon centred at (160, 190), Applications at (480, 190).
import AppKit

let width: CGFloat = 640, height: CGFloat = 400

func color(_ hex: UInt32, _ a: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: a)
}

func draw(scale: CGFloat) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(width * scale), pixelsHigh: Int(height * scale),
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: width, height: height)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let ctx = NSGraphicsContext.current!.cgContext
    // Top-down coordinates, like Finder's icon positions.
    ctx.translateBy(x: 0, y: height)
    ctx.scaleBy(x: 1, y: -1)

    NSGradient(starting: color(0x4a5361), ending: color(0x262b33))!
        .draw(in: NSRect(x: 0, y: 0, width: width, height: height), angle: 90)
    // Soft blue glow behind the app, like the Edge's lit tile.
    let glow = NSGradient(colors: [color(0x4cc2ff, 0.22), color(0x4cc2ff, 0)])!
    glow.draw(fromCenter: NSPoint(x: 160, y: 190), radius: 0, toCenter: NSPoint(x: 160, y: 190), radius: 150, options: [])

    // Arrow from the app to Applications.
    let arrow = NSBezierPath()
    arrow.move(to: NSPoint(x: 250, y: 190))
    arrow.line(to: NSPoint(x: 378, y: 190))
    arrow.lineWidth = 6
    arrow.lineCapStyle = .round
    color(0xffffff, 0.55).setStroke()
    arrow.stroke()
    let head = NSBezierPath()
    head.move(to: NSPoint(x: 366, y: 174))
    head.line(to: NSPoint(x: 392, y: 190))
    head.line(to: NSPoint(x: 366, y: 206))
    head.lineWidth = 6
    head.lineCapStyle = .round
    head.lineJoinStyle = .round
    head.stroke()

    // Text is drawn in a flipped context so it reads the right way up.
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
    func text(_ s: String, size: CGFloat, weight: NSFont.Weight, alpha: CGFloat, y: CGFloat) {
        let para = NSMutableParagraphStyle()
        para.alignment = .center
        let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: size, weight: weight),
                                                    .foregroundColor: color(0xffffff, alpha), .paragraphStyle: para]
        (s as NSString).draw(in: NSRect(x: 0, y: y, width: width, height: size * 1.5), withAttributes: attrs)
    }
    text("Drag EdgeDeck into Applications", size: 20, weight: .semibold, alpha: 0.95, y: 46)
    text("Then open it from Applications to set it up.", size: 13, weight: .regular, alpha: 0.7, y: 322)

    NSGraphicsContext.restoreGraphicsState()
    return rep
}

let dir = URL(fileURLWithPath: NSTemporaryDirectory())
let one = dir.appendingPathComponent("dmg-bg.png"), two = dir.appendingPathComponent("dmg-bg@2x.png")
try! draw(scale: 1).representation(using: .png, properties: [:])!.write(to: one)
try! draw(scale: 2).representation(using: .png, properties: [:])!.write(to: two)
if CommandLine.arguments.count > 1 { try? FileManager.default.removeItem(atPath: CommandLine.arguments[1]); try! FileManager.default.copyItem(at: two, to: URL(fileURLWithPath: CommandLine.arguments[1])) }

let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/tiffutil")
p.arguments = ["-cathidpicheck", one.path, two.path, "-out", "Resources/dmg-background.tiff"]
try! p.run()
p.waitUntilExit()
print(p.terminationStatus == 0 ? "Wrote Resources/dmg-background.tiff" : "tiffutil failed")
