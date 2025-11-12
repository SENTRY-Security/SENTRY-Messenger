import Foundation

public enum CallMediaStateStatus: String, Codable {
    case idle
    case keyPending = "key_pending"
    case ready
    case rotating
    case failed
}

public struct CallMediaToggle: Codable, Equatable {
    public var enabled: Bool
    public var codec: String
    public var profile: String?
    public var resolution: String?
    public var frameRate: Int?
    public var bitrate: Int?
    public var maxBitrate: Int?
    public var minBitrate: Int?
    public var channelCount: Int?

    public init(
        enabled: Bool = true,
        codec: String = "opus",
        profile: String? = nil,
        resolution: String? = nil,
        frameRate: Int? = nil,
        bitrate: Int? = nil,
        maxBitrate: Int? = nil,
        minBitrate: Int? = nil,
        channelCount: Int? = nil
    ) {
        self.enabled = enabled
        self.codec = codec.lowercased()
        self.profile = profile?.lowercased()
        self.resolution = resolution?.lowercased()
        self.frameRate = frameRate
        self.bitrate = bitrate
        self.maxBitrate = maxBitrate
        self.minBitrate = minBitrate
        self.channelCount = channelCount
    }
}

public struct CallMediaDescriptor: Codable, Equatable {
    public var audio: CallMediaToggle
    public var video: CallMediaToggle
    public var screenshare: CallMediaToggle

    public init(
        audio: CallMediaToggle = CallMediaDescriptor.defaults.audio,
        video: CallMediaToggle = CallMediaDescriptor.defaults.video,
        screenshare: CallMediaToggle = CallMediaDescriptor.defaults.screenshare
    ) {
        self.audio = audio
        self.video = video
        self.screenshare = screenshare
    }

    public static let defaults = CallMediaDescriptor(
        audio: CallMediaToggle(enabled: true, codec: "opus", bitrate: 32_000, channelCount: 1),
        video: CallMediaToggle(enabled: false, codec: "vp8", profile: "medium", resolution: "540p", frameRate: 30, maxBitrate: 900_000),
        screenshare: CallMediaToggle(enabled: false, codec: "vp9", frameRate: 15, maxBitrate: 1_200_000)
    )
}

public struct CallMediaCapability: Codable, Equatable {
    public var audio: Bool
    public var video: Bool
    public var screenshare: Bool
    public var insertableStreams: Bool
    public var sframe: Bool
    public var platform: String
    public var version: Int
    public var features: [String]
    public var maxSendBitrateKbps: Int?
    public var maxRecvBitrateKbps: Int?

    public init(
        audio: Bool = true,
        video: Bool = false,
        screenshare: Bool = false,
        insertableStreams: Bool = true,
        sframe: Bool = false,
        platform: String = "ios",
        version: Int = 1,
        features: [String] = [],
        maxSendBitrateKbps: Int? = nil,
        maxRecvBitrateKbps: Int? = nil
    ) {
        self.audio = audio
        self.video = video
        self.screenshare = screenshare
        self.insertableStreams = insertableStreams
        self.sframe = sframe
        self.platform = platform.lowercased()
        self.version = max(1, version)
        self.features = features.map { $0.lowercased() }
        self.maxSendBitrateKbps = maxSendBitrateKbps
        self.maxRecvBitrateKbps = maxRecvBitrateKbps
    }

    public static let webDefaults = CallMediaCapability(platform: "web")
}

public struct CallDerivedKeySet: Codable, Equatable {
    public var audioTx: Data?
    public var audioRx: Data?
    public var videoTx: Data?
    public var videoRx: Data?

    public init(audioTx: Data? = nil, audioRx: Data? = nil, videoTx: Data? = nil, videoRx: Data? = nil) {
        self.audioTx = audioTx
        self.audioRx = audioRx
        self.videoTx = videoTx
        self.videoRx = videoRx
    }
}

public struct CallFrameCounters: Codable, Equatable {
    public var audioTx: Int
    public var audioRx: Int
    public var videoTx: Int
    public var videoRx: Int

    public init(audioTx: Int = 0, audioRx: Int = 0, videoTx: Int = 0, videoRx: Int = 0) {
        self.audioTx = max(0, audioTx)
        self.audioRx = max(0, audioRx)
        self.videoTx = max(0, videoTx)
        self.videoRx = max(0, videoRx)
    }
}

public struct CallKeyEnvelope: Codable, Equatable {
    public static let typeValue = "call-key-envelope"

    public var type: String
    public var version: Int
    public var callId: UUID
    public var epoch: Int
    public var cmkSalt: String
    public var cmkProof: String
    public var media: CallMediaDescriptor
    public var capabilities: CallMediaCapability?
    public var metadata: [String: String]?
    public var createdAt: Date
    public var expiresAt: Date?

    public init(
        callId: UUID,
        epoch: Int,
        cmkSalt: String,
        cmkProof: String,
        media: CallMediaDescriptor = .defaults,
        capabilities: CallMediaCapability? = nil,
        metadata: [String: String]? = nil,
        version: Int = 1,
        createdAt: Date = Date(),
        expiresAt: Date? = nil
    ) {
        self.type = Self.typeValue
        self.version = version
        self.callId = callId
        self.epoch = max(0, epoch)
        self.cmkSalt = cmkSalt
        self.cmkProof = cmkProof
        self.media = media
        self.capabilities = capabilities
        self.metadata = metadata
        self.createdAt = createdAt
        self.expiresAt = expiresAt
    }
}

public struct CallMediaState: Codable, Equatable {
    public var schemaVersion: Int
    public var status: CallMediaStateStatus
    public var callId: UUID?
    public var epoch: Int
    public var cmkSalt: String?
    public var cmkProof: String?
    public var cmkMaterial: Data?
    public var derivedKeys: CallDerivedKeySet
    public var frameCounters: CallFrameCounters
    public var media: CallMediaDescriptor
    public var capabilities: CallMediaCapability
    public var lastError: String?
    public var lastRotateAt: Date?
    public var nextRotateAt: Date?
    public var rotateIntervalMs: Int
    public var pendingEnvelope: CallKeyEnvelope?
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        schemaVersion: Int = 1,
        status: CallMediaStateStatus = .idle,
        callId: UUID? = nil,
        epoch: Int = 0,
        cmkSalt: String? = nil,
        cmkProof: String? = nil,
        cmkMaterial: Data? = nil,
        derivedKeys: CallDerivedKeySet = CallDerivedKeySet(),
        frameCounters: CallFrameCounters = CallFrameCounters(),
        media: CallMediaDescriptor = .defaults,
        capabilities: CallMediaCapability = .webDefaults,
        lastError: String? = nil,
        lastRotateAt: Date? = nil,
        nextRotateAt: Date? = nil,
        rotateIntervalMs: Int = 600_000,
        pendingEnvelope: CallKeyEnvelope? = nil,
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.schemaVersion = schemaVersion
        self.status = status
        self.callId = callId
        self.epoch = max(0, epoch)
        self.cmkSalt = cmkSalt
        self.cmkProof = cmkProof
        self.cmkMaterial = cmkMaterial
        self.derivedKeys = derivedKeys
        self.frameCounters = frameCounters
        self.media = media
        self.capabilities = capabilities
        self.lastError = lastError
        self.lastRotateAt = lastRotateAt
        self.nextRotateAt = nextRotateAt
        self.rotateIntervalMs = max(30_000, rotateIntervalMs)
        self.pendingEnvelope = pendingEnvelope
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    public mutating func apply(envelope: CallKeyEnvelope) {
        self.pendingEnvelope = envelope
        self.callId = envelope.callId
        self.epoch = envelope.epoch
        self.cmkSalt = envelope.cmkSalt
        self.cmkProof = envelope.cmkProof
        self.media = envelope.media
        if let caps = envelope.capabilities {
            self.capabilities = caps
        }
        self.updatedAt = Date()
    }

    public mutating func setStatus(_ next: CallMediaStateStatus, error: String? = nil) {
        self.status = next
        self.lastError = error
        self.updatedAt = Date()
    }
}
