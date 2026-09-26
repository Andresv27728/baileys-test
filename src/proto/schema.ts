/**
 * Schema protobuf de WhatsApp.
 *
 * El schema real tiene ~2000 mensajes. Aquí está el subconjunto que necesita
 * el flujo completo: handshake, registro y envío/recepción de mensajes.
 * Los ids de campo son parte del protocolo: cambiar uno rompe la compatibilidad
 * con el servidor, así que van fijados a mano.
 */

import { defineSchema, lazySchema, type Schema } from './codec.ts'

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const MessageStatus = {
	ERROR: 0,
	PENDING: 1,
	SERVER_ACK: 2,
	DELIVERY_ACK: 3,
	READ: 4,
	PLAYED: 5
} as const

export const DisconnectReason = {
	LOGGED_OUT: 401,
	UNPAIRED: 411,
	BAD_SESSION: 428,
	CONFLICT: 440,
	FORBIDDEN: 403,
	SERVICE_UNAVAILABLE: 503
} as const

export const PendingNotificationType = {
	UNKNOWN: 0,
	CIPHERTEXT: 1,
	RETRY: 2,
	APP_STATE: 3,
	APP_STATE_SYNC: 4,
	APP_STATE_SYNC_KEY_SHARE: 5,
	APP_STATE_SYNC_KEY_REQUEST: 6,
	MSG_FANOUT_BACKFILL: 7,
	INITIAL_SECURITY_NOTIFICATION_SETTING_SYNC: 10,
	APP_STATE_FULL_CHANGESET: 11,
	PRIVACY_NOTIFICATION: 12,
	SUB_MIGRATION_NOTIFICATION: 13,
	USER_STATUS_MENTIONED_NOTIFICATION: 14
} as const

export const SyncActionType = {
	MSG_FANOUT_BACKFILL_REQUEST: 0,
	NOTIFICATION_MESSAGE: 1,
	HISTORY_SYNC_ONBOARDING: 3,
	HISTORY_SYNC_ONGOING: 4,
	APP_STATE: 5,
	APP_STATE_KEY_SHARE: 6,
	APP_STATE_KEY_REQUEST: 7,
	CONTACTS: 8,
	REGISTRATION: 9,
	DEVICE_INFO: 10,
	DEVICE_LIST: 11,
	STICKER_ACTION: 12,
	STICKER_REMOVE: 13,
	CALL_LOG: 14,
	BOT_TASK: 15,
	APP_STATE_FULL: 16,
	LID_MIGRATION: 17,
	SECRET_CHAT: 18,
	SMART_TO_REPLY: 19,
	AI_THREAD: 20,
	SMART_NOTIFICATIONS_SETTINGS: 21,
	REACTION_VOTING: 22
} as const

export const WAMessageStatus = MessageStatus

// ---------------------------------------------------------------------------
// Nodos base
// ---------------------------------------------------------------------------

export const MessageKey = defineSchema('MessageKey', {
	remoteJid: { type: 'string' },
	fromMe: { type: 'bool' },
	id: { type: 'string' },
	participant: { type: 'string' }
})

export const DeviceIdentity = defineSchema('DeviceIdentity', {
	rawId: { type: 'uint32' },
	timestamp: { type: 'uint64' },
	keyIndex: { type: 'uint32' },
	accountType: { type: 'enum' },
	deviceType: { type: 'enum' },
	deviceId: { type: 'bytes' },
	key: { type: 'bytes' }
})

export const DeviceIdentityMessage = defineSchema('DeviceIdentityMessage', {
	deviceIdentity: { type: 'message', msg: DeviceIdentity }
})

export const Ciphertext = defineSchema('Ciphertext', {
	iv: { type: 'bytes' },
	ciphertext: { type: 'bytes' }
})

// `ContextInfo` y `Message` se referencian mutuamente (un mensaje puede citar
// otro). Se crean diferidos y se rellenan cuando ya existen ambos.
// `ContextInfo` y `Message` se referencian mutuamente (un mensaje puede citar
// otro), y ambos cuelgan de otros mensajes. Se declaran primero como schemas
// vacíos y se rellenan al final, cuando ya están todos los referenciados.
export const ContextInfo = lazySchema('ContextInfo')
export const Message = lazySchema('Message')

export const SenderKeyDistributionMessage = defineSchema('SenderKeyDistributionMessage', {
	groupId: { type: 'string' },
	axolotlSenderKeyDistributionMessage: { type: 'bytes' }
})

export const DisappearingMode = defineSchema('DisappearingMode', {
	initiator: { type: 'enum' },
	trigger: { type: 'enum' },
	initiatorDeviceJid: { type: 'string' },
	initiatedByMe: { type: 'bool' }
})

export const HistorySyncNotification = defineSchema('HistorySyncNotification', {
	fileSha256: { type: 'bytes' },
	fileLength: { type: 'uint64' },
	mediaType: { type: 'enum' },
	directPath: { type: 'string' },
	mediaKey: { type: 'bytes' },
	mediaKeyTimestamp: { type: 'int64' },
	contextInfo: { type: 'message', msg: ContextInfo }
})

Object.assign(ContextInfo.fields, {
	stanzaId: { id: 1, type: 'string', name: 'stanzaId' },
	participant: { id: 2, type: 'string', name: 'participant' },
	quotedMessage: { id: 3, type: 'message', name: 'quotedMessage', msg: Message },
	mentionedJid: { id: 4, type: 'string', name: 'mentionedJid' },
	conversionSource: { id: 5, type: 'string', name: 'conversionSource' },
	conversionData: { id: 6, type: 'bytes', name: 'conversionData' },
	forwardingScore: { id: 7, type: 'uint32', name: 'forwardingScore' },
	isForwarded: { id: 8, type: 'bool', name: 'isForwarded' },
	placeholderKey: { id: 9, type: 'message', name: 'placeholderKey', msg: MessageKey },
	expiration: { id: 10, type: 'uint32', name: 'expiration' },
	ephemeralSettingTimestamp: { id: 11, type: 'int64', name: 'ephemeralSettingTimestamp' },
	ephemeralSharedSecret: { id: 12, type: 'bytes', name: 'ephemeralSharedSecret' },
	entryPointConversionSource: { id: 18, type: 'string', name: 'entryPointConversionSource' },
	entryPointConversionApp: { id: 19, type: 'string', name: 'entryPointConversionApp' },
	entryPointConversionDelay: { id: 20, type: 'uint32', name: 'entryPointConversionDelay' },
	disappearingMode: { id: 21, type: 'message', name: 'disappearingMode', msg: DisappearingMode }
})

Object.assign(Message.fields, {
	conversation: { id: 1, type: 'string', name: 'conversation' },
	senderKeyDistributionMessage: { id: 2, type: 'message', name: 'senderKeyDistributionMessage', msg: SenderKeyDistributionMessage },
	extendedTextMessage: { id: 3, type: 'message', name: 'extendedTextMessage', msg: defineSchema('ExtendedTextMessage', {
		text: { type: 'string' },
		matchedText: { type: 'string' },
		canonicalLink: { type: 'string' },
		description: { type: 'string' },
		title: { type: 'string' },
		textArgb: { type: 'fixed32' },
		backgroundArgb: { type: 'fixed32' },
		font: { type: 'enum' },
		previewType: { type: 'enum' },
		contextInfo: { type: 'message', msg: ContextInfo }
	}) },
	imageMessage: { id: 4, type: 'message', name: 'imageMessage', msg: defineSchema('ImageMessage', {
		url: { type: 'string' },
		mimetype: { type: 'string' },
		caption: { type: 'string' },
		fileSha256: { type: 'bytes' },
		fileLength: { type: 'uint64' },
		height: { type: 'uint32' },
		width: { type: 'uint32' },
		mediaKey: { type: 'bytes' },
		fileEncSha256: { type: 'bytes' },
		directPath: { type: 'string' },
		mediaKeyTimestamp: { type: 'int64' },
		jpegThumbnail: { type: 'bytes' },
		contextInfo: { type: 'message', msg: ContextInfo }
	}) },
	locationMessage: { id: 5, type: 'message', name: 'locationMessage', msg: defineSchema('LocationMessage', {
		degreesLatitude: { type: 'double' },
		degreesLongitude: { type: 'double' },
		name: { type: 'string' },
		address: { type: 'string' },
		url: { type: 'string' },
		contextInfo: { type: 'message', msg: ContextInfo }
	}) },
	videoMessage: { id: 6, type: 'message', name: 'videoMessage', msg: defineSchema('VideoMessage', {
		url: { type: 'string' },
		mimetype: { type: 'string' },
		fileSha256: { type: 'bytes' },
		fileLength: { type: 'uint64' },
		seconds: { type: 'uint32' },
		mediaKey: { type: 'bytes' },
		fileEncSha256: { type: 'bytes' },
		directPath: { type: 'string' },
		gifPlayback: { type: 'bool' },
		mediaKeyTimestamp: { type: 'int64' },
		jpegThumbnail: { type: 'bytes' },
		contextInfo: { type: 'message', msg: ContextInfo }
	}) },
	audioMessage: { id: 7, type: 'message', name: 'audioMessage', msg: defineSchema('AudioMessage', {
		url: { type: 'string' },
		mimetype: { type: 'string' },
		fileSha256: { type: 'bytes' },
		fileLength: { type: 'uint64' },
		seconds: { type: 'uint32' },
		ptt: { type: 'bool' },
		mediaKey: { type: 'bytes' },
		fileEncSha256: { type: 'bytes' },
		directPath: { type: 'string' },
		mediaKeyTimestamp: { type: 'int64' },
		contextInfo: { type: 'message', msg: ContextInfo }
	}) },
	documentMessage: { id: 8, type: 'message', name: 'documentMessage', msg: defineSchema('DocumentMessage', {
		url: { type: 'string' },
		mimetype: { type: 'string' },
		title: { type: 'string' },
		fileSha256: { type: 'bytes' },
		fileLength: { type: 'uint64' },
		pageCount: { type: 'uint32' },
		mediaKey: { type: 'bytes' },
		fileName: { type: 'string' },
		fileEncSha256: { type: 'bytes' },
		directPath: { type: 'string' },
		mediaKeyTimestamp: { type: 'int64' },
		contactVcard: { type: 'bool' },
		contextInfo: { type: 'message', msg: ContextInfo }
	}) },
	stickerMessage: { id: 9, type: 'message', name: 'stickerMessage', msg: defineSchema('StickerMessage', {
		url: { type: 'string' },
		fileSha256: { type: 'bytes' },
		fileEncSha256: { type: 'bytes' },
		mediaKey: { type: 'bytes' },
		mimetype: { type: 'string' },
		height: { type: 'uint32' },
		width: { type: 'uint32' },
		directPath: { type: 'string' },
		fileLength: { type: 'uint64' },
		mediaKeyTimestamp: { type: 'int64' },
		isAnimated: { type: 'bool' },
		contextInfo: { type: 'message', msg: ContextInfo }
	}) },
	protocolMessage: { id: 12, type: 'message', name: 'protocolMessage', msg: defineSchema('ProtocolMessage', {
		key: { type: 'message', msg: MessageKey },
		type: { type: 'enum' },
		ephemeralExpiration: { type: 'uint32' },
		ephemeralSettingTimestamp: { type: 'int64' },
		historySyncNotification: { type: 'message', msg: HistorySyncNotification },
		deviceIdentityMessage: { type: 'message', msg: DeviceIdentityMessage }
	}) },
	contactMessage: { id: 35, type: 'message', name: 'contactMessage', msg: defineSchema('ContactMessage', {
		displayName: { type: 'string' },
		vcard: { type: 'string' },
		contextInfo: { type: 'message', msg: ContextInfo }
	}) },
	reactionMessage: { id: 46, type: 'message', name: 'reactionMessage', msg: defineSchema('ReactionMessage', {
		key: { type: 'message', msg: MessageKey },
		text: { type: 'string' },
		senderTimestampMs: { type: 'int64' }
	}) }
})

// ---------------------------------------------------------------------------
// Handshake / Noise
// ---------------------------------------------------------------------------

export const UserAgent = defineSchema('UserAgent', {
	platform: { type: 'enum' },
	appVersion: { type: 'string' },
	mcc: { type: 'string' },
	mnc: { type: 'string' },
	locale: { type: 'string' },
	phoneManufacturer: { type: 'string' },
	device: { type: 'enum' },
	phoneId: { type: 'bytes' },
	releaseChannel: { type: 'enum' },
	osVersion: { type: 'string' },
	manufacturer: { type: 'string' },
	phone: { type: 'string' },
	phoneCountry: { type: 'string' },
	phoneRegion: { type: 'string' },
	osBuildNumber: { type: 'string' }
})

export const WebInfo = defineSchema('WebInfo', {
	refToken: { type: 'bytes' },
	version: { type: 'string' },
	platform: { type: 'enum' },
	platformType: { type: 'enum' },
	webSubPlatform: { type: 'enum' }
})

export const DeviceProps = defineSchema('DeviceProps', {
	os: { type: 'string' },
	platformType: { type: 'enum' },
	requireFullSync: { type: 'bool' }
})

export const ClientHelloPayload = defineSchema('ClientHelloPayload', {
	ref: { type: 'bytes' },
	userAgent: { type: 'message', msg: UserAgent },
	webInfo: { type: 'message', msg: WebInfo },
	pairStart: { type: 'bool' },
	timestamp: { type: 'uint64' },
	reconnectCount: { type: 'uint32' },
	deviceIdentity: { type: 'message', msg: DeviceIdentityMessage },
	deviceProps: { type: 'message', msg: DeviceProps },
	companionProto: { type: 'enum' },
	companionPubKeys: { type: 'bytes' },
	vendor: { type: 'string' },
	os: { type: 'string' },
	reactToMessageIdInE2EEMsg: { type: 'message', msg: MessageKey }
})

export const ServerHelloPayload = defineSchema('ServerHelloPayload', {
	ref: { type: 'bytes' },
	ephemeral: { type: 'bytes' },
	static: { type: 'bytes' },
	payload: { type: 'bytes' },
	timestamp: { type: 'uint64' }
})

export const ClientFinishPayload = defineSchema('ClientFinishPayload', {
	static: { type: 'bytes' },
	payload: { type: 'bytes' },
	extendedLocalKey: { type: 'bytes' }
})

export const NoiseKeyExchange = defineSchema('NoiseKeyExchange', {
	hash: { type: 'bytes' },
	signature: { type: 'bytes' },
	ephemeral: { type: 'bytes' }
})

export const NoiseHandshake = defineSchema('NoiseHandshake', {
	clientHello: { type: 'message', msg: NoiseKeyExchange },
	serverHello: { type: 'message', msg: NoiseKeyExchange },
	intermediaryHello: { type: 'message', msg: NoiseKeyExchange },
	clientFinish: { type: 'message', msg: NoiseKeyExchange },
	serverFinish: { type: 'message', msg: NoiseKeyExchange }
})

// ---------------------------------------------------------------------------
// Registro (QR pairing)
// ---------------------------------------------------------------------------

export const CodePairDevice = defineSchema('CodePairDevice', {
	ref: { type: 'bytes' },
	currentMasterKey: { type: 'bytes' },
	currentDeviceKey: { type: 'bytes' },
	accountType: { type: 'enum' },
	deviceType: { type: 'enum' },
	deviceProps: { type: 'message', msg: DeviceProps }
})

export const CodePairMsg = defineSchema('CodePairMsg', {
	ephemeral: { type: 'bytes' },
	codePairDevice: { type: 'message', msg: CodePairDevice }
})

export const CodePairSuccess = defineSchema('CodePairSuccess', {
	deviceIdentity: { type: 'message', msg: DeviceIdentityMessage }
})

export const CodePairFailure = defineSchema('CodePairFailure', {
	reason: { type: 'enum' }
})

export const IdentitySync = defineSchema('IdentitySync', {
	accountType: { type: 'enum' },
	deviceType: { type: 'enum' },
	deviceId: { type: 'bytes' },
	deviceProps: { type: 'message', msg: DeviceProps }
})

export const AccountSettings = defineSchema('AccountSettings', {
	unarchiveChats: { type: 'bool' },
	starredMessages: { type: 'bytes' },
	statusPrivacy: { type: 'enum' },
	readReceipts: { type: 'bool' },
	typingIndicator: { type: 'bool' },
	keptMessages: { type: 'int32' },
	lastAutoDeleteDays: { type: 'int32' },
	mediaVisibility: { type: 'enum' }
})

export const AccountSync = defineSchema('AccountSync', {
	unarchiveChats: { type: 'bool' },
	starredMessages: { type: 'bytes' },
	statusPrivacy: { type: 'enum' },
	unreadChats: { type: 'int32' },
	oldPushName: { type: 'string' },
	accountType: { type: 'enum' },
	deviceType: { type: 'enum' },
	deviceId: { type: 'bytes' },
	accountSettings: { type: 'message', msg: AccountSettings },
	deviceProps: { type: 'message', msg: DeviceProps }
})

// ---------------------------------------------------------------------------
// Signal
// ---------------------------------------------------------------------------

export const SignalMessage = defineSchema('SignalMessage', {
	ratchetKey: { type: 'bytes' },
	counter: { type: 'uint32' },
	previousCounter: { type: 'uint32' },
	ciphertext: { type: 'bytes' },
	encrypted: { type: 'bool' }
})

export const PreSignalKeyBundle = defineSchema('PreSignalKeyBundle', {
	registrationId: { type: 'uint32' },
	preKeyId: { type: 'uint32' },
	signedPreKeyId: { type: 'uint32' },
	signedPreKey: { type: 'bytes' },
	signature: { type: 'bytes' },
	identityKey: { type: 'bytes' }
})

export const PreSignalMessage = defineSchema('PreSignalMessage', {
	registrationId: { type: 'uint32' },
	preKeyId: { type: 'uint32' },
	signedPreKeyId: { type: 'uint32' },
	baseKey: { type: 'bytes' },
	identityKey: { type: 'bytes' },
	message: { type: 'bytes' }
})

export const SenderKeyMessage = defineSchema('SenderKeyMessage', {
	id: { type: 'uint32' },
	iteration: { type: 'uint32' },
	ciphertext: { type: 'bytes' }
})

export const KeyBundle = defineSchema('KeyBundle', {
	registrationId: { type: 'uint32' },
	deviceId: { type: 'uint32' },
	preKey: { type: 'bytes' },
	signedPreKey: { type: 'bytes' },
	preKeySignature: { type: 'bytes' },
	identityKey: { type: 'bytes' }
})

export const SignalProtocolMessage = defineSchema('SignalProtocolMessage', {
	registrationId: { type: 'uint32' },
	type: { type: 'enum' },
	senderPreKey: { type: 'message', msg: PreSignalKeyBundle },
	preKey: { type: 'message', msg: KeyBundle },
	encrypted: { type: 'message', msg: Ciphertext },
	ciphertext: { type: 'bytes' },
	ephemeral: { type: 'bytes' }
})

export const DecryptedSignalMessage = defineSchema('DecryptedSignalMessage', {
	registrationId: { type: 'uint32' },
	key: { type: 'message', msg: MessageKey },
	encrypted: { type: 'message', msg: Ciphertext },
	plaintext: { type: 'bytes' }
})

export const DeviceSentMessage = defineSchema('DeviceSentMessage', {
	destinationJid: { type: 'string' },
	message: { type: 'message', msg: Message },
	phash: { type: 'string' }
})

export const DecryptedMessage = defineSchema('DecryptedMessage', {
	fromMe: { type: 'bool' },
	deviceSentMessage: { type: 'message', msg: DeviceSentMessage }
})

// ---------------------------------------------------------------------------
// Mensajes de primer nivel
// ---------------------------------------------------------------------------

export const DeviceListMetadata = defineSchema('DeviceListMetadata', {
	senderKeyHash: { type: 'bytes' },
	senderTimestamp: { type: 'uint64' },
	senderKeyIndex: { type: 'uint32' }
})

export const ProtocolMessageElement = defineSchema('ProtocolMessageElement', {
	deviceIndex: { type: 'uint32' },
	deviceIdentity: { type: 'message', msg: DeviceIdentity }
})

export const ProtocolArrayMessage = defineSchema('ProtocolArrayMessage', {
	elements: { type: 'message', msg: ProtocolMessageElement }
})

export const ProtocolDeviceArray = defineSchema('ProtocolDeviceArray', {
	deviceIds: { type: 'message', msg: ProtocolArrayMessage }
})

export const BotMetadata = defineSchema('BotMetadata', {
	personaId: { type: 'string' },
	invokerJid: { type: 'string' },
	sessionId: { type: 'string' },
	messageIndex: { type: 'int32' },
	invocationSource: { type: 'string' }
})

export const MessageAssociation = defineSchema('MessageAssociation', {
	associationType: { type: 'enum' }
})

export const MessageContext = defineSchema('MessageContext', {
	deviceListMetadata: { type: 'message', msg: DeviceListMetadata },
	deviceListMetadataVersion: { type: 'int32' },
	deviceList: { type: 'message', msg: ProtocolDeviceArray },
	messageSecret: { type: 'bytes' },
	paddingBytes: { type: 'bytes' },
	messageAddOnDurationInSecs: { type: 'uint32' },
	botMessageSecret: { type: 'bytes' },
	botMetadata: { type: 'message', msg: BotMetadata },
	reportingTokenVersion: { type: 'uint32' },
	messageAddOnExpiryType: { type: 'enum' },
	botMessageAssociation: { type: 'message', msg: MessageAssociation }
})

export const ReportingTokenInfo = defineSchema('ReportingTokenInfo', {
	reportingTag: { type: 'bytes' },
	reportingTagVersion: { type: 'uint32' }
})

export const EventAdditionalMessageFields = defineSchema('EventAdditionalMessageFields', {
	groupMentions: { type: 'message', msg: defineSchema('GroupMentions', { groupJid: { type: 'string' } }) }
})

export const InteractiveResponseMessage = defineSchema('InteractiveResponseMessage', {
	body: { type: 'string' },
	footer: { type: 'string' },
	contextInfo: { type: 'message', msg: ContextInfo },
	selectedRowId: { type: 'string' },
	type: { type: 'enum' }
})

export const WebMessageInfo = defineSchema('WebMessageInfo', {
	key: { type: 'message', msg: MessageKey },
	message: { type: 'message', msg: Message },
	messageTimestamp: { type: 'uint64' },
	status: { type: 'enum' },
	participant: { type: 'string' },
	messageC2STimestamp: { type: 'uint64' },
	ignore: { type: 'bool' },
	starred: { type: 'bool' },
	broadcast: { type: 'bool' },
	pushName: { type: 'string' },
	multicast: { type: 'bool' },
	urlText: { type: 'bool' },
	mediaKey: { type: 'bytes' },
	mediaCaption: { type: 'string' },
	encKey: { type: 'bytes' },
	directPath: { type: 'string' },
	mediaKeyTimestamp: { type: 'int64' },
	clientUrl: { type: 'string' },
	interactiveResponseMessage: { type: 'message', msg: InteractiveResponseMessage },
	ephemeralStartTimestamp: { type: 'int64' },
	ephemeralDuration: { type: 'int32' },
	viewOnce: { type: 'bool' },
	verifiedBizName: { type: 'string' },
	viewOnceV2: { type: 'bool' },
	viewOnceV2Expiration: { type: 'uint64' },
	editedMessage: { type: 'message', msg: Message },
	timestampMs: { type: 'int64' },
	botMetadata: { type: 'message', msg: BotMetadata },
	reportingTokenInfo: { type: 'message', msg: ReportingTokenInfo },
	newsletterServerId: { type: 'int64' },
	eventAdditionalInfo: { type: 'message', msg: EventAdditionalMessageFields }
})

export const FutureProofMessage = defineSchema('FutureProofMessage', {
	message: { type: 'message', msg: Message }
})

export const MessageStub = defineSchema('MessageStub', {
	type: { type: 'enum' },
	message: { type: 'message', msg: Message },
	subtype: { type: 'enum' }
})

export const PendingMessageNotification = defineSchema('PendingMessageNotification', {
	key: { type: 'message', msg: MessageKey },
	message: { type: 'bytes' },
	messageTimestamp: { type: 'uint64' },
	status: { type: 'enum' }
})

export const HistorySyncOnRequest = defineSchema('HistorySyncOnRequest', {
	type: { type: 'enum' }
})

export const PlaceholderMessageResend = defineSchema('PlaceholderMessageResend', {
	messageKey: { type: 'message', msg: MessageKey }
})

export const MediaRetryMessage = defineSchema('MediaRetryMessage', {})

export const PeerDataOperationRequestType = defineSchema('PeerDataOperationRequestType', {
	historySyncOnRequest: { type: 'message', msg: HistorySyncOnRequest },
	placeholderMessageResend: { type: 'message', msg: PlaceholderMessageResend },
	mediaRetryMessage: { type: 'message', msg: MediaRetryMessage }
})

export const PeerDataOperationRequestMessage = defineSchema('PeerDataOperationRequestMessage', {
	peerDataOperationRequestType: { type: 'message', msg: PeerDataOperationRequestType },
	requestMessage: { type: 'message', msg: Message }
})

export const PlaceholderMessageResendResult = defineSchema('PlaceholderMessageResendResult', {
	webMessageInfoBytes: { type: 'bytes' }
})

export const MediaRetryResult = defineSchema('MediaRetryResult', {
	stale: { type: 'enum' },
	result: { type: 'enum' },
	directPath: { type: 'string' },
	mediaKey: { type: 'bytes' },
	handle: { type: 'string' }
})

export const PeerDataOperationResultType = defineSchema('PeerDataOperationResultType', {
	historySyncOnRequest: { type: 'message', msg: HistorySyncOnRequest },
	placeholderMessageResend: { type: 'message', msg: PlaceholderMessageResendResult },
	mediaRetryMessage: { type: 'message', msg: MediaRetryResult }
})

export const PeerDataOperationResultMessage = defineSchema('PeerDataOperationResultMessage', {
	peerDataOperationResultType: { type: 'message', msg: PeerDataOperationResultType }
})

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

export const SyncActionCollectionId = defineSchema('SyncActionCollectionId', {
	fromDeviceId: { type: 'int32' },
	collectionId: { type: 'bytes' },
	collectionName: { type: 'string' }
})

export const SyncActionIndex = defineSchema('SyncActionIndex', {
	blob: { type: 'bytes' }
})

export const SyncActionData = defineSchema('SyncActionData', {
	indexes: { type: 'message', msg: SyncActionIndex },
	version: { type: 'uint32' },
	bytes: { type: 'bytes' },
	collectionId: { type: 'message', msg: SyncActionCollectionId }
})

export const AppStateBody = defineSchema('AppStateBody', {
	version: { type: 'uint32' },
	critical: { type: 'message', msg: SyncActionData },
	discard: { type: 'message', msg: SyncActionData },
	dataShareOptin: { type: 'bool' },
	featureName: { type: 'string' },
	participant: { type: 'string' },
	locale: { type: 'string' }
})

export const PatchData = defineSchema('PatchData', {
	blob: { type: 'bytes' },
	base64Blob: { type: 'string' }
})

export const AppStatePatch = defineSchema('AppStatePatch', {
	patch: { type: 'message', msg: PatchData }
})

export const AppStatePatchData = defineSchema('AppStatePatchData', {
	patch: { type: 'message', msg: PatchData }
})

export const KeyData = defineSchema('KeyData', {
	keyId: { type: 'uint32' },
	keyValue: { type: 'bytes' },
	keyFingerprint: { type: 'bytes' }
})

export const KeyShareEntry = defineSchema('KeyShareEntry', {
	userJid: { type: 'string' },
	deviceId: { type: 'uint32' },
	keyData: { type: 'message', msg: KeyData }
})

export const KeyShare = defineSchema('KeyShare', {
	keys: { type: 'message', msg: KeyShareEntry }
})

export const AppStateSyncKeyShare = defineSchema('AppStateSyncKeyShare', {
	keys: { type: 'message', msg: KeyShare }
})

export const AppState = defineSchema('AppState', {
	keyShare: { type: 'message', msg: AppStateSyncKeyShare },
	patches: { type: 'message', msg: AppStatePatch }
})

export const AppStateChangeset = defineSchema('AppStateChangeset', {
	locale: { type: 'string' },
	patches: { type: 'message', msg: AppStatePatch },
	version: { type: 'uint32' }
})

export const AppStateFullChangeset = defineSchema('AppStateFullChangeset', {
	changeset: { type: 'message', msg: AppStateChangeset }
})

export const ProtocolMessageNotification = defineSchema('ProtocolMessageNotification', {
	historySyncNotification: { type: 'message', msg: HistorySyncNotification },
	appState: { type: 'message', msg: AppState },
	appStatePatch: { type: 'message', msg: AppStatePatch },
	appStateChangeset: { type: 'message', msg: AppStateChangeset },
	appStateFullChangeset: { type: 'message', msg: AppStateFullChangeset },
	peerDataOperationRequestMessage: { type: 'message', msg: PeerDataOperationRequestMessage },
	peerDataOperationResultMessage: { type: 'message', msg: PeerDataOperationResultMessage }
})

// ---------------------------------------------------------------------------
// Notificaciones
// ---------------------------------------------------------------------------

export const Notification = defineSchema('Notification', {
	type: { type: 'enum' },
	message: { type: 'bytes' },
	participant: { type: 'string' }
})

export const DecryptedNotification = defineSchema('DecryptedNotification', {
	pluginMetadata: { type: 'message', msg: defineSchema('PluginMetadata', { pluginType: { type: 'enum' } }) },
	appStateSyncKeyShare: { type: 'message', msg: AppStateSyncKeyShare },
	protocolMessage: { type: 'message', msg: ProtocolMessageNotification },
	deviceListMetadata: { type: 'message', msg: DeviceListMetadata },
	deviceListMetadataVersion: { type: 'int32' },
	timestamp: { type: 'uint64' },
	type: { type: 'enum' },
	message: { type: 'message', msg: Message },
	offset: { type: 'uint32' },
	participant: { type: 'string' },
	participantTimestamp: { type: 'uint64' },
	botMetadata: { type: 'message', msg: BotMetadata },
	blob: { type: 'bytes' }
})

export const MediaData = defineSchema('MediaData', {
	localPath: { type: 'string' },
	fileLength: { type: 'uint64' },
	directPath: { type: 'string' },
	handle: { type: 'string' },
	mimetype: { type: 'string' },
	fileEncSha256: { type: 'bytes' },
	mediaKey: { type: 'bytes' },
	mediaKeyTimestamp: { type: 'int64' }
})

export const PushNotification = defineSchema('PushNotification', {
	notification: { type: 'message', msg: Notification },
	mediaData: { type: 'message', msg: MediaData }
})

// ---------------------------------------------------------------------------
// Índices de acceso rápido
// ---------------------------------------------------------------------------

export const WAProto = {
	NoiseKeyExchange,
	NoiseHandshake,
	ClientHelloPayload,
	ServerHelloPayload,
	ClientFinishPayload,
	UserAgent,
	WebInfo,
	DeviceProps,
	DeviceIdentity,
	DeviceIdentityMessage,
	CodePairDevice,
	CodePairMsg,
	CodePairSuccess,
	CodePairFailure,
	IdentitySync,
	AccountSync,
	AccountSettings,
	Ciphertext,
	MessageKey,
	ContextInfo,
	Message,
	WebMessageInfo,
	MessageContext,
	DeviceListMetadata,
	ProtocolDeviceArray,
	ProtocolArrayMessage,
	ProtocolMessageElement,
	SignalMessage,
	PreSignalMessage,
	PreSignalKeyBundle,
	KeyBundle,
	SignalProtocolMessage,
	DecryptedSignalMessage,
	DecryptedMessage,
	DeviceSentMessage,
	SenderKeyMessage,
	SenderKeyDistributionMessage,
	Notification,
	DecryptedNotification,
	PushNotification,
	AppState,
	AppStateBody,
	AppStatePatch,
	AppStateSyncKeyShare,
	AppStateChangeset,
	AppStateFullChangeset,
	ProtocolMessageNotification,
	MessageStub,
	PendingMessageNotification,
	PeerDataOperationRequestMessage,
	PeerDataOperationResultMessage,
	HistorySyncNotification,
	FutureProofMessage
} as const satisfies Record<string, Schema>
