#pragma once

#include "./common.h"
#include "./hosted-plugin.h"
#include "wclap/index-lookup.hpp"

#include <memory>
#include <optional>
#include <string>
#include <vector>
#include <iostream>

namespace impl32 {
using namespace wclap32;

// Takes ownership of an Instance
struct HostedWclap {
	struct PresetFiletype {
		std::string providerId, name, description, extension;
	};
	struct PresetLocation {
		std::string providerId, name, location;
		uint32_t kind = 0, flags = 0;
		bool hasLocation = false;
	};
	struct PresetSoundpack {
		std::string providerId, id, name, description, homepage, vendor, imagePath;
		uint32_t flags = 0;
		wclap_timestamp releaseTimestamp = WCLAP_TIMESTAMP_UNKNOWN;
	};
	struct PresetProvider {
		std::string id, name, vendor;
		Pointer<const wclap_preset_discovery_provider> pointer;
	};
	struct PresetPluginId {
		std::string abi, id;
	};
	struct PresetMetadata {
		std::string name, loadKey, soundpackId, description;
		bool hasName = false, hasLoadKey = false;
		uint32_t flags = 0;
		wclap_timestamp creationTimestamp = WCLAP_TIMESTAMP_UNKNOWN;
		wclap_timestamp modificationTimestamp = WCLAP_TIMESTAMP_UNKNOWN;
		std::vector<PresetPluginId> pluginIds;
		std::vector<std::string> creators, features;
		std::vector<std::pair<std::string, std::string>> extraInfo;
	};

	bool ok = false;
	const char *reason = nullptr;

	// Host structures
	wclap_host host;
	Pointer<wclap_host_audio_ports> audioPortsExtPtr;
	Pointer<wclap_host_gui> guiExtPtr;
	Pointer<wclap_host_latency> latencyExtPtr;
	Pointer<wclap_host_log> logExtPtr;
	Pointer<wclap_host_note_ports> notePortsExtPtr;
	Pointer<wclap_host_params> paramsExtPtr;
	Pointer<wclap_host_preset_load> presetLoadExtPtr;
	Pointer<wclap_host_state> stateExtPtr;
	Pointer<wclap_host_tail> tailExtPtr;
	Pointer<wclap_host_webview> webviewExtPtr;
	Pointer<wclap_preset_discovery_indexer> presetIndexerPtr;
	Pointer<wclap_preset_discovery_metadata_receiver> presetMetadataReceiverPtr;
	wclap_input_events inputEvents;
	wclap_output_events outputEvents;
	wclap_istream istream;
	wclap_ostream ostream;

	// Instance and supporting state
	std::unique_ptr<Instance> instance;
	wclap::MemoryArenaPool<Instance, false> arenaPool;
	std::unique_ptr<wclap::MemoryArena<Instance, false>> globalArena;
	
	wclap::IndexLookup<HostedPlugin> pluginLookup;
	Pointer<wclap_plugin_factory> pluginFactoryPtr;
	Pointer<wclap_preset_discovery_factory> presetDiscoveryFactoryPtr;
	std::vector<PresetProvider> presetProviders;
	std::vector<PresetFiletype> presetFiletypes;
	std::vector<PresetLocation> presetLocations;
	std::vector<PresetSoundpack> presetSoundpacks;
	std::vector<PresetMetadata> presetMetadata;
	std::vector<std::string> presetErrors;
	std::string activePresetProviderId;
	bool presetProvidersInitialised = false;

	std::optional<std::string> readOptionalString(Pointer<const char> pointer) {
		if (!pointer) return std::nullopt;
		auto length = instance->countUntil(pointer, 0, 65535);
		std::string result(length, 0);
		instance->getArray(pointer, result.data(), length);
		return result;
	}
	std::string readString(Pointer<const char> pointer) {
		return readOptionalString(pointer).value_or("");
	}
	
	static Pointer<const void> hostGetExtension32(void *context, Pointer<const wclap_host> host, Pointer<const char> extensionIdPtr) {
		auto &self = *(HostedWclap *)context;
		char extensionId[256] = {};
		self.instance->getArray(extensionIdPtr, extensionId, 255);
		
		if (!std::strcmp(extensionId, "clap.audio-ports")) return self.audioPortsExtPtr.cast<const void>();
		if (!std::strcmp(extensionId, "clap.gui")) return self.guiExtPtr.cast<const void>();
		if (!std::strcmp(extensionId, "clap.latency")) return self.latencyExtPtr.cast<const void>();
		if (!std::strcmp(extensionId, "clap.log")) return self.logExtPtr.cast<const void>();
		if (!std::strcmp(extensionId, "clap.note-ports")) return self.notePortsExtPtr.cast<const void>();
		if (!std::strcmp(extensionId, "clap.params")) return self.paramsExtPtr.cast<const void>();
		if (!std::strcmp(extensionId, WCLAP_EXT_PRESET_LOAD)) return self.presetLoadExtPtr.cast<const void>();
		if (!std::strcmp(extensionId, WCLAP_EXT_PRESET_LOAD_COMPAT)) return self.presetLoadExtPtr.cast<const void>();
		if (!std::strcmp(extensionId, "clap.state")) return self.stateExtPtr.cast<const void>();
		if (!std::strcmp(extensionId, "clap.tail")) return self.tailExtPtr.cast<const void>();
		if (!std::strcmp(extensionId, "clap.webview/3")) return self.webviewExtPtr.cast<const void>();
		
		std::cout << "Unsupported WCLAP host extension: " << extensionId << std::endl;
		return {0}; // no extensions for now
	}
	static void hostRequestRestart32(void *context, Pointer<const wclap_host> host) {
		auto *plugin = getPlugin(context, host);
		if (plugin) plugin->hostRequestRestart();
	}
	static void hostRequestProcess32(void *context, Pointer<const wclap_host> host) {
		auto *plugin = getPlugin(context, host);
		if (plugin) plugin->hostRequestProcess();
	}
	static void hostRequestCallback32(void *context, Pointer<const wclap_host> host) {
		auto *plugin = getPlugin(context, host);
		if (plugin) plugin->hostRequestCallback();
	}

	static uint32_t inputEventsSize32(void *context, Pointer<const wclap_input_events> events) {
		auto *plugin = getPlugin(context, events);
		if (plugin) return plugin->inputEventsSize();
		return 0;
	}
	static Pointer<const wclap_event_header> inputEventsGet32(void *context, Pointer<const wclap_input_events> events, uint32_t index) {
		auto *plugin = getPlugin(context, events);
		if (plugin) return plugin->inputEventsGet(index);
		return {0};
	}
	static bool outputEventsTryPush32(void *context, Pointer<const wclap_output_events> events, Pointer<const wclap_event_header> event) {
		auto *plugin = getPlugin(context, events);
		if (plugin) return plugin->outputEventsTryPush(event);
		return false;
	}
	
	static int64_t istreamRead32(void *context, Pointer<const wclap_istream> stream, Pointer<void> buffer, uint64_t size) {
		auto *plugin = getPlugin(context, stream);
		if (plugin) return plugin->istreamRead(buffer, size);
		return -1;
	}
	static int64_t ostreamWrite32(void *context, Pointer<const wclap_ostream> stream, Pointer<const void> buffer, uint64_t size) {
		auto *plugin = getPlugin(context, stream);
		if (plugin) return plugin->ostreamWrite(buffer, size);
		return -1;
	}

	static bool audioPortsIsRescanFlagSupported32(void *context, Pointer<const wclap_host> host, uint32_t flag) {
		auto *plugin = getPlugin(context, host);
		if (plugin) return plugin->audioPortsIsRescanFlagSupported(flag);
		return false;
	}
	static void audioPortsRescan32(void *context, Pointer<const wclap_host> host, uint32_t flags) {
		auto *plugin = getPlugin(context, host);
		if (plugin) plugin->audioPortsRescan(flags);
	}

	static void guiResizeHintsChanged32(void *context, Pointer<const wclap_host> host) {
		auto *plugin = getPlugin(context, host);
		if (plugin) plugin->guiResizeHintsChanged();
	}
	static bool guiRequestResize32(void *context, Pointer<const wclap_host> host, uint32_t width, uint32_t height) {
		auto *plugin = getPlugin(context, host);
		if (plugin) return plugin->guiRequestResize(width, height);
		return false;
	}
	static bool guiRequestShow32(void *context, Pointer<const wclap_host> host) {
		auto *plugin = getPlugin(context, host);
		if (plugin) return plugin->guiRequestShow();
		return false;
	}
	static bool guiRequestHide32(void *context, Pointer<const wclap_host> host) {
		auto *plugin = getPlugin(context, host);
		if (plugin) return plugin->guiRequestHide();
		return false;
	}
	static void guiClosed32(void *context, Pointer<const wclap_host> host, bool wasDestroyed) {
		auto *plugin = getPlugin(context, host);
		if (plugin) plugin->guiClosed(wasDestroyed);
	}
	
	static void latencyChanged32(void *context, Pointer<const wclap_host> host) {
		auto *plugin = getPlugin(context, host);
		if (plugin) plugin->latencyChanged();
	}

	static void logLog32(void *context, Pointer<const wclap_host> host, int32_t severity, Pointer<const char> msg) {
		auto *plugin = getPlugin(context, host);
		if (plugin) plugin->log(severity, msg);
	}

	static uint32_t notePortsSupportedDialects32(void *context, Pointer<const wclap_host> host) {
		auto *plugin = getPlugin(context, host);
		if (plugin) return plugin->notePortsSupportedDialects();
		return 0;
	}
	static void notePortsRescan32(void *context, Pointer<const wclap_host> host, uint32_t flags) {
		auto *plugin = getPlugin(context, host);
		if (plugin) plugin->notePortsRescan(flags);
	}

	static void paramsRescan32(void *context, Pointer<const wclap_host> host, uint32_t flags) {
		auto *plugin = getPlugin(context, host);
		if (plugin) plugin->paramsRescan(flags);
	}
	static void paramsClear32(void *context, Pointer<const wclap_host> host, uint32_t paramId, uint32_t flags) {
		auto *plugin = getPlugin(context, host);
		if (plugin) plugin->paramsClear(paramId, flags);
	}
	static void paramsRequestFlush32(void *context, Pointer<const wclap_host> host) {
		auto *plugin = getPlugin(context, host);
		if (plugin) plugin->paramsRequestFlush();
	}

	static void presetLoadOnError32(void *context, Pointer<const wclap_host> host,
		uint32_t locationKind, Pointer<const char> location, Pointer<const char> loadKey,
		int32_t osError, Pointer<const char> message) {
		auto *plugin = getPlugin(context, host);
		if (plugin) plugin->presetLoadError(locationKind, location, loadKey, osError, message);
	}
	static void presetLoadLoaded32(void *context, Pointer<const wclap_host> host,
		uint32_t locationKind, Pointer<const char> location, Pointer<const char> loadKey) {
		auto *plugin = getPlugin(context, host);
		if (plugin) plugin->presetLoaded(locationKind, location, loadKey);
	}
	
	static void stateMarkDirty32(void *context, Pointer<const wclap_host> host) {
		auto *plugin = getPlugin(context, host);
		if (plugin) plugin->stateMarkDirty();
	}

	static bool presetDeclareFiletype32(void *context,
		Pointer<const wclap_preset_discovery_indexer>,
		Pointer<const wclap_preset_discovery_filetype> filetypePtr) {
		auto &self = *static_cast<HostedWclap *>(context);
		if (!filetypePtr) return false;
		auto filetype = self.instance->get(filetypePtr);
		self.presetFiletypes.push_back({self.activePresetProviderId,
			self.readString(filetype.name), self.readString(filetype.description),
			self.readString(filetype.file_extension)});
		return true;
	}
	static bool presetDeclareLocation32(void *context,
		Pointer<const wclap_preset_discovery_indexer>,
		Pointer<const wclap_preset_discovery_location> locationPtr) {
		auto &self = *static_cast<HostedWclap *>(context);
		if (!locationPtr) return false;
		auto location = self.instance->get(locationPtr);
		auto path = self.readOptionalString(location.location);
		self.presetLocations.push_back({self.activePresetProviderId,
			self.readString(location.name), path.value_or(""), location.kind,
			location.flags, path.has_value()});
		return true;
	}
	static bool presetDeclareSoundpack32(void *context,
		Pointer<const wclap_preset_discovery_indexer>,
		Pointer<const wclap_preset_discovery_soundpack> soundpackPtr) {
		auto &self = *static_cast<HostedWclap *>(context);
		if (!soundpackPtr) return false;
		auto soundpack = self.instance->get(soundpackPtr);
		self.presetSoundpacks.push_back({self.activePresetProviderId,
			self.readString(soundpack.id), self.readString(soundpack.name),
			self.readString(soundpack.description), self.readString(soundpack.homepage_url),
			self.readString(soundpack.vendor), self.readString(soundpack.image_path),
			soundpack.flags, soundpack.release_timestamp});
		return true;
	}
	static Pointer<const void> presetIndexerGetExtension32(void *,
		Pointer<const wclap_preset_discovery_indexer>, Pointer<const char>) {
		return {0};
	}

	static void presetMetadataError32(void *context,
		Pointer<const wclap_preset_discovery_metadata_receiver>, int32_t,
		Pointer<const char> message) {
		auto &self = *static_cast<HostedWclap *>(context);
		self.presetErrors.push_back(self.readString(message));
	}
	static bool presetMetadataBegin32(void *context,
		Pointer<const wclap_preset_discovery_metadata_receiver>,
		Pointer<const char> name, Pointer<const char> loadKey) {
		auto &self = *static_cast<HostedWclap *>(context);
		auto nameValue = self.readOptionalString(name);
		auto loadKeyValue = self.readOptionalString(loadKey);
		PresetMetadata metadata;
		metadata.name = nameValue.value_or("");
		metadata.loadKey = loadKeyValue.value_or("");
		metadata.hasName = nameValue.has_value();
		metadata.hasLoadKey = loadKeyValue.has_value();
		self.presetMetadata.push_back(std::move(metadata));
		return true;
	}
	static void presetMetadataAddPluginId32(void *context,
		Pointer<const wclap_preset_discovery_metadata_receiver>,
		Pointer<const wclap_universal_plugin_id> pluginIdPtr) {
		auto &self = *static_cast<HostedWclap *>(context);
		if (self.presetMetadata.empty() || !pluginIdPtr) return;
		auto pluginId = self.instance->get(pluginIdPtr);
		self.presetMetadata.back().pluginIds.push_back({
			self.readString(pluginId.abi), self.readString(pluginId.id)});
	}
	static void presetMetadataSetSoundpack32(void *context,
		Pointer<const wclap_preset_discovery_metadata_receiver>, Pointer<const char> id) {
		auto &self = *static_cast<HostedWclap *>(context);
		if (!self.presetMetadata.empty()) self.presetMetadata.back().soundpackId = self.readString(id);
	}
	static void presetMetadataSetFlags32(void *context,
		Pointer<const wclap_preset_discovery_metadata_receiver>, uint32_t flags) {
		auto &self = *static_cast<HostedWclap *>(context);
		if (!self.presetMetadata.empty()) self.presetMetadata.back().flags = flags;
	}
	static void presetMetadataAddCreator32(void *context,
		Pointer<const wclap_preset_discovery_metadata_receiver>, Pointer<const char> creator) {
		auto &self = *static_cast<HostedWclap *>(context);
		if (!self.presetMetadata.empty()) self.presetMetadata.back().creators.push_back(self.readString(creator));
	}
	static void presetMetadataSetDescription32(void *context,
		Pointer<const wclap_preset_discovery_metadata_receiver>, Pointer<const char> description) {
		auto &self = *static_cast<HostedWclap *>(context);
		if (!self.presetMetadata.empty()) self.presetMetadata.back().description = self.readString(description);
	}
	static void presetMetadataSetTimestamps32(void *context,
		Pointer<const wclap_preset_discovery_metadata_receiver>,
		wclap_timestamp creation, wclap_timestamp modification) {
		auto &self = *static_cast<HostedWclap *>(context);
		if (self.presetMetadata.empty()) return;
		self.presetMetadata.back().creationTimestamp = creation;
		self.presetMetadata.back().modificationTimestamp = modification;
	}
	static void presetMetadataAddFeature32(void *context,
		Pointer<const wclap_preset_discovery_metadata_receiver>, Pointer<const char> feature) {
		auto &self = *static_cast<HostedWclap *>(context);
		if (!self.presetMetadata.empty()) self.presetMetadata.back().features.push_back(self.readString(feature));
	}
	static void presetMetadataAddExtraInfo32(void *context,
		Pointer<const wclap_preset_discovery_metadata_receiver>,
		Pointer<const char> key, Pointer<const char> value) {
		auto &self = *static_cast<HostedWclap *>(context);
		if (!self.presetMetadata.empty()) self.presetMetadata.back().extraInfo.push_back({
			self.readString(key), self.readString(value)});
	}

	static void tailChanged32(void *context, Pointer<const wclap_host> host) {
		auto *plugin = getPlugin(context, host);
		if (plugin) plugin->tailChanged();
	}

	static bool webviewSend32(void *context, Pointer<const wclap_host> host, Pointer<const void> buffer, uint32_t size) {
		auto *plugin = getPlugin(context, host);
		if (plugin) return plugin->webviewSend(buffer, size);
		return false;
	}

	HostedWclap(Instance *instance) : instance(instance), arenaPool(instance), globalArena(arenaPool.getOrCreate()) {
		setup();
	}
	void setup() {
		auto failWithError = [&](const char *message){
			reason = message;
		};
		if (instance->is64()) return failWithError("64-bit WCLAP not supported");

		// Set up all the host structures we'll need later
		// This registers all the host methods, before the instance gets locked by `.init()`
		auto globalScoped = globalArena->scoped();
		// Host is a template - we don't store it here, but separately for each plugin
		host.wclap_version = {1, 2, 7};
		host.host_data = {0}; // this will get filled in later, as an index into `pluginList`
		host.name = globalScoped.writeString("CLAP AudioNode (WCLAP host)");
		host.vendor = globalScoped.writeString("Signalsmith Audio");
		host.url = globalScoped.writeString("https://github.com/Signalsmith-Audio/wasm-clap-browserhost");
		host.version = globalScoped.writeString("1.0.0");
		host.get_extension = instance->registerHost32(this, hostGetExtension32);
		host.request_restart = instance->registerHost32(this, hostRequestRestart32);
		host.request_process = instance->registerHost32(this, hostRequestProcess32);
		host.request_callback = instance->registerHost32(this, hostRequestCallback32);
		inputEvents.ctx = {0};
		inputEvents.size = instance->registerHost32(this, inputEventsSize32);
		inputEvents.get = instance->registerHost32(this, inputEventsGet32);
		outputEvents.ctx = {0};
		outputEvents.try_push = instance->registerHost32(this, outputEventsTryPush32);
		istream.ctx = {0};
		istream.read = instance->registerHost32(this, istreamRead32);
		ostream.ctx = {0};
		ostream.write = instance->registerHost32(this, ostreamWrite32);
		
		// Host extensions - functions defined above
		audioPortsExtPtr = globalScoped.copyAcross(wclap_host_audio_ports{
			.is_rescan_flag_supported=instance->registerHost32(this, audioPortsIsRescanFlagSupported32),
			.rescan=instance->registerHost32(this, audioPortsRescan32),
		});
		guiExtPtr = globalScoped.copyAcross(wclap_host_gui{
			.resize_hints_changed=instance->registerHost32(this, guiResizeHintsChanged32),
			.request_resize=instance->registerHost32(this, guiRequestResize32),
			.request_show=instance->registerHost32(this, guiRequestShow32),
			.request_hide=instance->registerHost32(this, guiRequestHide32),
			.closed=instance->registerHost32(this, guiClosed32),
		});
		latencyExtPtr = globalScoped.copyAcross(wclap_host_latency{
			.changed=instance->registerHost32(this, latencyChanged32),
		});
		logExtPtr = globalScoped.copyAcross(wclap_host_log{
			.log=instance->registerHost32(this, logLog32),
		});
		notePortsExtPtr = globalScoped.copyAcross(wclap_host_note_ports{
			.supported_dialects=instance->registerHost32(this, notePortsSupportedDialects32),
			.rescan=instance->registerHost32(this, notePortsRescan32),
		});
		paramsExtPtr = globalScoped.copyAcross(wclap_host_params{
			.rescan=instance->registerHost32(this, paramsRescan32),
			.clear=instance->registerHost32(this, paramsClear32),
			.request_flush=instance->registerHost32(this, paramsRequestFlush32),
		});
		presetLoadExtPtr = globalScoped.copyAcross(wclap_host_preset_load{
			.on_error=instance->registerHost32(this, presetLoadOnError32),
			.loaded=instance->registerHost32(this, presetLoadLoaded32),
		});
		stateExtPtr = globalScoped.copyAcross(wclap_host_state{
			.mark_dirty=instance->registerHost32(this, stateMarkDirty32),
		});
		tailExtPtr = globalScoped.copyAcross(wclap_host_tail{
			.changed=instance->registerHost32(this, tailChanged32),
		});
		webviewExtPtr = globalScoped.copyAcross(wclap_host_webview{
			.send=instance->registerHost32(this, webviewSend32),
		});
		presetIndexerPtr = globalScoped.copyAcross(wclap_preset_discovery_indexer{
			.wclap_version={1, 2, 7},
			.name=globalScoped.writeString("CLAP AudioNode preset indexer"),
			.vendor=globalScoped.writeString("Signalsmith Audio"),
			.url=globalScoped.writeString("https://github.com/WebCLAP/browser-test-host"),
			.version=globalScoped.writeString("1.0.0"),
			.indexer_data={0},
			.declare_filetype=instance->registerHost32(this, presetDeclareFiletype32),
			.declare_location=instance->registerHost32(this, presetDeclareLocation32),
			.declare_soundpack=instance->registerHost32(this, presetDeclareSoundpack32),
			.get_extension=instance->registerHost32(this, presetIndexerGetExtension32),
		});
		presetMetadataReceiverPtr = globalScoped.copyAcross(wclap_preset_discovery_metadata_receiver{
			.receiver_data={0},
			.on_error=instance->registerHost32(this, presetMetadataError32),
			.begin_preset=instance->registerHost32(this, presetMetadataBegin32),
			.add_plugin_id=instance->registerHost32(this, presetMetadataAddPluginId32),
			.set_soundpack_id=instance->registerHost32(this, presetMetadataSetSoundpack32),
			.set_flags=instance->registerHost32(this, presetMetadataSetFlags32),
			.add_creator=instance->registerHost32(this, presetMetadataAddCreator32),
			.set_description=instance->registerHost32(this, presetMetadataSetDescription32),
			.set_timestamps=instance->registerHost32(this, presetMetadataSetTimestamps32),
			.add_feature=instance->registerHost32(this, presetMetadataAddFeature32),
			.add_extra_info=instance->registerHost32(this, presetMetadataAddExtraInfo32),
		});

		globalScoped.commit(); // Save this stuff for the WCLAP lifetime
		
		instance->init();
		
		if (!instance->entry32) return failWithError("no clap_entry");
		auto entry = instance->get(instance->entry32);
		
		// Call clap_entry.init();
		auto scoped = arenaPool.scoped();
		if (!instance->call(entry.init, scoped.writeString(instance->path()))) return failWithError("clap_entry.init() failed");

		// Get the plugin factory
		pluginFactoryPtr = instance->call(entry.get_factory, scoped.writeString("clap.plugin-factory"))
			.cast<wclap_plugin_factory>();
		if (!pluginFactoryPtr) {
			instance->call(entry.deinit);
			return failWithError("no plugin factory found");
		}
		presetDiscoveryFactoryPtr = instance->call(entry.get_factory,
			scoped.writeString(WCLAP_PRESET_DISCOVERY_FACTORY_ID)).cast<wclap_preset_discovery_factory>();
		if (!presetDiscoveryFactoryPtr) {
			presetDiscoveryFactoryPtr = instance->call(entry.get_factory,
				scoped.writeString(WCLAP_PRESET_DISCOVERY_FACTORY_ID_COMPAT)).cast<wclap_preset_discovery_factory>();
		}

		ok = true;
	}
	~HostedWclap() {
		for (auto &providerInfo : presetProviders) {
			auto provider = instance->get(providerInfo.pointer);
			instance->call(provider.destroy, providerInfo.pointer);
		}
		if (ok) { // Call clap_entry.deinit()
			auto entry = instance->get(instance->entry32);
			instance->call(entry.deinit);
		}
	}

	void initialisePresetProviders() {
		if (presetProvidersInitialised || !presetDiscoveryFactoryPtr) return;
		presetProvidersInitialised = true;
		auto scoped = arenaPool.scoped();
		auto factory = instance->get(presetDiscoveryFactoryPtr);
		auto count = instance->call(factory.count, presetDiscoveryFactoryPtr);
		for (uint32_t index = 0; index < count; ++index) {
			auto descriptorPtr = instance->call(factory.get_descriptor,
				presetDiscoveryFactoryPtr, index);
			if (!descriptorPtr) continue;
			auto descriptor = instance->get(descriptorPtr);
			auto id = readString(descriptor.id);
			activePresetProviderId = id;
			auto providerPtr = instance->call(factory.create, presetDiscoveryFactoryPtr,
				presetIndexerPtr, scoped.writeString(id.c_str()));
			if (!providerPtr) continue;
			auto provider = instance->get(providerPtr);
			if (!instance->call(provider.init, providerPtr)) {
				instance->call(provider.destroy, providerPtr);
				continue;
			}
			presetProviders.push_back({id, readString(descriptor.name),
				readString(descriptor.vendor), providerPtr});
		}
		activePresetProviderId.clear();
	}

	void getPresetDiscovery(CborWriter &cbor) {
		initialisePresetProviders();
		cbor.openArray();
		for (const auto &provider : presetProviders) {
			cbor.openMap();
			cbor.addUtf8("id"); cbor.addUtf8(provider.id);
			cbor.addUtf8("name"); cbor.addUtf8(provider.name);
			cbor.addUtf8("vendor"); cbor.addUtf8(provider.vendor);
			cbor.addUtf8("filetypes"); cbor.openArray();
			for (const auto &filetype : presetFiletypes) if (filetype.providerId == provider.id) {
				cbor.openMap();
				cbor.addUtf8("name"); cbor.addUtf8(filetype.name);
				cbor.addUtf8("description"); cbor.addUtf8(filetype.description);
				cbor.addUtf8("extension"); cbor.addUtf8(filetype.extension);
				cbor.close();
			}
			cbor.close();
			cbor.addUtf8("locations"); cbor.openArray();
			for (const auto &location : presetLocations) if (location.providerId == provider.id) {
				cbor.openMap();
				cbor.addUtf8("name"); cbor.addUtf8(location.name);
				cbor.addUtf8("kind"); cbor.addInt(location.kind);
				cbor.addUtf8("flags"); cbor.addInt(location.flags);
				cbor.addUtf8("location");
				if (location.hasLocation) cbor.addUtf8(location.location); else cbor.addNull();
				cbor.close();
			}
			cbor.close();
			cbor.addUtf8("soundpacks"); cbor.openArray();
			for (const auto &soundpack : presetSoundpacks) if (soundpack.providerId == provider.id) {
				cbor.openMap();
				cbor.addUtf8("id"); cbor.addUtf8(soundpack.id);
				cbor.addUtf8("name"); cbor.addUtf8(soundpack.name);
				cbor.addUtf8("description"); cbor.addUtf8(soundpack.description);
				cbor.addUtf8("homepage"); cbor.addUtf8(soundpack.homepage);
				cbor.addUtf8("vendor"); cbor.addUtf8(soundpack.vendor);
				cbor.addUtf8("imagePath"); cbor.addUtf8(soundpack.imagePath);
				cbor.addUtf8("flags"); cbor.addInt(soundpack.flags);
				cbor.addUtf8("releaseTimestamp"); cbor.addInt(soundpack.releaseTimestamp);
				cbor.close();
			}
			cbor.close();
			cbor.close();
		}
		cbor.close();
	}

	void getPresetMetadata(const std::string &providerId, uint32_t locationKind,
		const std::string &location, CborWriter &cbor) {
		initialisePresetProviders();
		presetMetadata.clear();
		presetErrors.clear();
		auto found = std::find_if(presetProviders.begin(), presetProviders.end(),
			[&](const auto &provider) { return provider.id == providerId; });
		bool success = false;
		if (found != presetProviders.end()) {
			auto provider = instance->get(found->pointer);
			if (location.empty()) {
				// Plugin-contained presets require a null location. Avoid taking a
				// temporary arena for this case: some WCLAP allocators do not tolerate
				// an otherwise-unused cross-instance allocation during metadata calls.
				success = instance->call(provider.get_metadata, found->pointer,
					locationKind, Pointer<const char>{0}, presetMetadataReceiverPtr);
			} else {
				auto scoped = arenaPool.scoped();
				success = instance->call(provider.get_metadata, found->pointer,
					locationKind, scoped.writeString(location.c_str()), presetMetadataReceiverPtr);
			}
		}
		cbor.openMap();
		cbor.addUtf8("success"); cbor.addBool(success);
		cbor.addUtf8("presets"); cbor.openArray();
		for (const auto &metadata : presetMetadata) {
			cbor.openMap();
			cbor.addUtf8("name");
			if (metadata.hasName) cbor.addUtf8(metadata.name); else cbor.addNull();
			cbor.addUtf8("loadKey");
			if (metadata.hasLoadKey) cbor.addUtf8(metadata.loadKey); else cbor.addNull();
			cbor.addUtf8("soundpackId"); cbor.addUtf8(metadata.soundpackId);
			cbor.addUtf8("description"); cbor.addUtf8(metadata.description);
			cbor.addUtf8("flags"); cbor.addInt(metadata.flags);
			cbor.addUtf8("creationTimestamp"); cbor.addInt(metadata.creationTimestamp);
			cbor.addUtf8("modificationTimestamp"); cbor.addInt(metadata.modificationTimestamp);
			cbor.addUtf8("pluginIds"); cbor.openArray();
			for (const auto &pluginId : metadata.pluginIds) {
				cbor.openMap();
				cbor.addUtf8("abi"); cbor.addUtf8(pluginId.abi);
				cbor.addUtf8("id"); cbor.addUtf8(pluginId.id);
				cbor.close();
			}
			cbor.close();
			cbor.addUtf8("creators"); cbor.openArray();
			for (const auto &creator : metadata.creators) cbor.addUtf8(creator);
			cbor.close();
			cbor.addUtf8("features"); cbor.openArray();
			for (const auto &feature : metadata.features) cbor.addUtf8(feature);
			cbor.close();
			cbor.addUtf8("extraInfo"); cbor.openMap();
			for (const auto &entry : metadata.extraInfo) {
				cbor.addUtf8(entry.first); cbor.addUtf8(entry.second);
			}
			cbor.close();
			cbor.close();
		}
		cbor.close();
		cbor.addUtf8("errors"); cbor.openArray();
		for (const auto &error : presetErrors) cbor.addUtf8(error);
		cbor.close();
		cbor.close();
	}
	
	static HostedWclap * create(Instance *instance) {
		auto *hosted = new HostedWclap(instance);
		if (!hosted->ok) {
			if (hosted->reason) std::cerr << hosted->reason << std::endl;
			delete hosted;
			return nullptr;
		}
		return hosted;
	}

	void getInfo(CborWriter &cbor) {
		cbor.openMap();
		
		auto scoped = arenaPool.scoped();

		auto entry = instance->get(instance->entry32);

		cbor.addUtf8("clapVersion");
		cbor.openArray(3);
		cbor.addInt(entry.wclap_version.major);
		cbor.addInt(entry.wclap_version.minor);
		cbor.addInt(entry.wclap_version.revision);

		cbor.addUtf8("path");
		cbor.addUtf8(instance->path());

		cbor.addUtf8("plugins");
		cbor.openArray();
		
		auto pluginFactory = instance->get(pluginFactoryPtr);
		auto count = instance->call(pluginFactory.get_plugin_count, pluginFactoryPtr);
		for (uint32_t i = 0; i < count; ++i) {
			auto ptr = instance->call(pluginFactory.get_plugin_descriptor, pluginFactoryPtr, i);
			if (!ptr) continue;
			auto descriptor = instance->get(ptr);
			writeDescriptorCbor(instance, cbor, descriptor);
		}
		
		cbor.close(); // array
		cbor.close(); // map
	}
	
	// Get the plugin pointer from the context pointer of various host-provided objects
	static HostedPlugin * getPlugin(void *context, Pointer<const wclap_host> hostPtr) {
		auto &self = *(HostedWclap *)context;
		Pointer<void> dataPtr = self.instance->get(hostPtr[&wclap_host::host_data]);
		return self.pluginLookup.get(int32_t(dataPtr.wasmPointer));
	}
	template<class WclapType>
	static HostedPlugin * getPlugin(void *context, Pointer<const WclapType> events) {
		auto &self = *(HostedWclap *)context;
		Pointer<void> dataPtr = self.instance->get(events[&WclapType::ctx]);
		return self.pluginLookup.get(int32_t(dataPtr.wasmPointer));
	}
	
	HostedPlugin * createPlugin(const char *pluginId) {
		auto scoped = arenaPool.scoped();

		// Write the host structures into WCLAP memory
		auto hostPtr = scoped.copyAcross(host);
		auto inputEventsPtr = scoped.copyAcross(inputEvents);
		auto outputEventsPtr = scoped.copyAcross(outputEvents);
		auto istreamPtr = scoped.copyAcross(istream);
		auto ostreamPtr = scoped.copyAcross(ostream);
		// Attempt to actually create the plugin using the plugin factory
		auto fnPtr = pluginFactoryPtr[&wclap_plugin_factory::create_plugin];
		auto pluginPtr = instance->call(fnPtr, pluginFactoryPtr, hostPtr, scoped.writeString(pluginId));
		if (!pluginPtr) {
			std::cerr << "Failed to create WCLAP plugin: " << pluginId << "\n";
			return nullptr;
		}

		// `scoped.commit()` keeps the host structures above for the plugin's lifetime, and also claims the arena
		auto *plugin = new HostedPlugin(pluginPtr, instance.get(), scoped.commit());
		uint32_t pluginIndex = pluginLookup.retain(plugin);
		plugin->pluginIndex = pluginIndex;
		plugin->inputEventsPtr = inputEventsPtr;
		plugin->outputEventsPtr = outputEventsPtr;
		plugin->istreamPtr = istreamPtr;
		plugin->ostreamPtr = ostreamPtr;
		
		// Write the plugin index into the context pointers
		instance->set(hostPtr[&wclap_host::host_data], {pluginIndex});
		instance->set(inputEventsPtr[&wclap_input_events::ctx], {pluginIndex});
		instance->set(outputEventsPtr[&wclap_output_events::ctx], {pluginIndex});
		instance->set(istreamPtr[&wclap_istream::ctx], {pluginIndex});
		instance->set(ostreamPtr[&wclap_ostream::ctx], {pluginIndex});
		
		std::cout << "Created WCLAP plugin: " << pluginId << "\n";
		plugin->init();
		return plugin;
	}
};
} // namespace

using HostedWclap = impl32::HostedWclap;
