# Arlo Plugin for Scrypted

## Introduction

The Arlo Plugin connects Scrypted to Arlo Cloud, allowing you to access all of your Arlo cameras in Scrypted.

Arlo no longer limits active logins per account, so you can use the Arlo app, website, and this plugin simultaneously without logging out of any devices. However, be mindful of any potential conflicts or issues that may arise when using the plugin concurrently with other Arlo services.

The plugin supports Local RTSP streaming from cameras that support `local live streaming` in the Arlo App, when the camera is connected to a basestation that also supports `local live streaming`. This Local RTSP stream pulls the secured stream directly from the basestation without having to access the Arlo Cloud, creating less overhead. Local RTSP is only available for cameras owned by the account the plugin logs in with; cameras shared with that account get Cloud RTSP, and WebRTC if they support it.

The account you use for this plugin must have either **SMS** or **EMAIL** set as the default MFA option. Once you enter your username and password on the plugin settings page, you should receive a MFA code through your default MFA option. Enter that code into the provided box, and your cameras will appear in Scrypted. Or, see below for configuring IMAP to auto-login with MFA.

If you experience any trouble logging in, turn on **Force Re-Authentication** in the plugin settings, which resets the login and asks for a new MFA code.

> **Note:** If you add or remove cameras in your Arlo account, this plugin defaults to refresh the device list from Arlo Cloud every 15 minutes. This should pull in new devices automatically, but if you need them immediately restart the plugin manually.

---

## Requirements

- Scrypted on Linux (x64 or arm64), macOS (Intel or Apple silicon), or Windows (x64 or arm64). 32-bit ARM is not supported.
- On its first start, and after an update that changes it, the plugin downloads its HTTP library ([libcurl-impersonate](https://github.com/lexiforest/curl-impersonate), about 32 MB) from GitHub into the plugin's data folder, so the Scrypted server must be able to reach GitHub at that time.

---

## General Setup Notes

- **Switching from the Python plugin (0.11 or 0.12):** Install this version over it. Your devices keep their HomeKit pairings and Scrypted settings (from 0.11, the siren security systems are created again). Arlo asks for a new MFA code, and camera switches that were on, such as **Plugged In to External Power**, and hidden devices need setting again. To go back, uninstall this version first.

- **MFA Requirement:** Ensure that your Arlo account's default MFA option is set to either SMS or EMAIL. Without this, you will not be able to log in and use the plugin. The plugin will require you to enter a MFA code once your credentials are entered. This code is sent to you via your selected method, and you will need to input it into the plugin settings.

- **Motion Event Notifications:** Motion event notifications must be enabled in the Arlo app. This is important because when motion is detected, the plugin will receive these events and trigger actions. If you are receiving push notifications directly from Arlo, you can disable these notifications in your phone's settings after enabling them in the Arlo app. This avoids receiving duplicate alerts from both the Arlo app and Scrypted or any other downstream options.

- **Smart Detection & Recording Settings:** Disable smart detection and any cloud or local recording options in the Arlo app. Arlo limits to a single active stream per camera. If smart detection or any recording is enabled, it may conflict with the plugin's ability to stream video, particularly when motion events trigger. Disabling these features ensures that you can get uninterrupted access to the live feed for downstream services (like HomeKit) to access the video stream properly.

- **Rebroadcast Plugin:** It is highly recommended to enable the Rebroadcast Plugin in Scrypted. This will allow multiple downstream integrations (such as HomeKit) to access the video feed from a single camera simultaneously. Without the rebroadcast plugin, only one device or platform can access the video feed at a time.

- **Stream Types:** The plugin supports three types of video streams:
  - **WebRTC**: This stream option is the standard connection type for most cameras and doorbells through the Arlo app, and needs the WebRTC Plugin. The connection process does take a little longer, but does seem to be reliable. Downstream services (like HomeKit) may automatically transcode WebRTC streams for recording because of the audio requirements for HomeKit Secure Video.
  - **Local RTSP**: This stream is available if the camera and basestation it is connected to support it. This stream should connect quickly and keep all communication on the local network. Downstream services (like HomeKit) may automatically transcode Local RTSP streams for live streaming because of the audio requirements for HomeKit Live Streaming.
  - **Cloud RTSP**: This stream is usually faster in connecting and recording. Downstream services (like HomeKit) may automatically transcode Cloud RTSP streams for live streaming because of the audio requirements for HomeKit Live Streaming.

  Scrypted can also add **Synthetic Streams**, which use one of these three as their source and transcode it on demand with the FFmpeg arguments provided.

  Note that Arlo's single-stream limitation means you can only use one of these stream types at a time. If you have one stream selected for streaming and another for recording, if a downstream service (like HomeKit) tries to access a camera while the stream is already open, it may prevent recording. Therefore, it is recommended to use the same stream type for all streams in Scrypted and the Rebroadcast plugin will handle sending the same stream to multiple places, i.e. streaming while recording. There is a limitation from Arlo on the number of concurrent local live streams that a basestation can handle, the maximum is 5 streams at one time. This means that if you have more than 5 cameras connected to a basestation, that only 5 of them can connect and stream locally at a time. If 5 cameras are already connected and streaming locally, either live streaming or recording, if any others try to connect and stream locally, it will fail.

- **Video Codecs:** Arlo cameras send H.264 or H.265; newer models, such as the Essential Generation 2 cameras, send H.265. A downstream service that needs H.264, like HomeKit, has to transcode H.265 streams, using the FFmpeg (TCP) Parser or a Synthetic stream. This is not necessary for WebRTC streaming.

- **Downstream Plugin RTP Sender:** The recommended RTP Sender in the HomeKit plugin or similar plugins is `default`. If you have any issues with recording or streaming, try setting the RTP Sender to `FFmpeg`. The default configuration helps ensure compatibility between Scrypted and downstream services (like HomeKit).

- **Prebuffering:** Enable prebuffering only if the camera is connected to a constant power source (e.g., wall outlet). Solar panels often do not provide sufficient power for prebuffering to function correctly. This feature is most useful for wired cameras with a steady power supply, and will only work when the camera does not have a battery, or when **Plugged In to External Power** is turned on in the camera's settings.

- **Pan and Tilt:** Pan-tilt cameras can be moved from Scrypted, including to their presets and home position, and get switches for HomeKit: Pan Left, Pan Right, Tilt Up, Tilt Down, Home Position and one per preset.

> **Bandwidth Usage:** Keep in mind that using anything other than the Local RTSP stream type, streaming and recording video uses extra bandwidth, as video and audio streams must travel from your camera to Arlo Cloud, and then from Arlo Cloud to your network, before finally reaching Scrypted. This additional round-trip may affect your network speed and performance.

---

## Two-Way Audio

Each camera with a speaker gets an **Intercom** device, which carries two-way audio and needs the WebRTC Plugin. A camera talks in one of two ways, chosen from what it supports:

- **SIP**, used by most current cameras. Talking joins the session of the camera's running Cloud RTSP stream, so a Cloud RTSP stream must be open, such as a live view in HomeKit.
- **WebRTC push-to-talk**, used by older cameras and some doorbells. Talking works without an open stream.

With the WebRTC stream type, talking happens inside the same session as the video.

---

## Lights and Status LEDs

- Spotlights, floodlights and nightlights appear as their own light devices, starting from the state the camera reports.
- A camera's own on/off switch controls its status light on cameras that have one, such as the wired indoor VMC3070A, and otherwise its charge notification LED.

---

## IMAP MFA

The plugin supports using **IMAP** to automatically retrieve Arlo MFA codes from email. Your Arlo account must have **EMAIL** selected as the default MFA method.

- Tested with Gmail, but compatible with any IMAP provider.
- See [Gmail IMAP settings](https://support.google.com/mail/answer/7126229?hl=en).
- Generate a Gmail [App Password](https://support.google.com/accounts/answer/185833?hl=en) to use in place of your normal password.

The plugin looks for MFA codes sent from `do_not_reply@arlo.com`. If you use an email forwarding service (e.g. iCloud Hide My Email), confirm that the sender address is not overwritten, and update the plugin's IMAP settings accordingly.

---

## Virtual Security System for Arlo Sirens

Sirens in HomeKit appear as simple on/off switches, which are easy to accidentally trigger. This plugin creates a virtual security system device for each siren to prevent accidental activation.

- The virtual system is synced to HomeKit as a separate accessory.
- This is **not tied to actual Arlo Security Modes**—it only protects the siren from accidental activation.
- See the device's own README in Scrypted for details on the virtual security system.

---

## Virtual Security System for Arlo Security Modes

With **Control Arlo Security Modes** turned on in the plugin settings, the plugin exposes Arlo App Security Modes (Away, Home, Standby) as a security system in Scrypted and HomeKit. This lets you automate camera notification behavior based on mode.

### Example Automation Flow

1. In the Home App:
   - Set all cameras to "Stream & Record" for both Home and Away.
2. In the Arlo App:
   - Configure the **Away mode** to send notifications from all cameras.
   - Configure the **Home mode** to send notifications from select cameras.
   - Configure **Standby mode** to disable all notifications.
3. Use automations in the Home App to switch the Arlo security mode by controlling the virtual system in Scrypted.

> Scrypted only receives events from Arlo when notifications are enabled for a camera in the selected security mode. HomeKit Secure Video recordings depend on receiving these notifications.

Multiple virtual security systems may be created—one per location (user or shared). Each system is labeled according to its location name in the Arlo App.

> Note: The plugin does **not** modify your Arlo Security Mode settings—only switches between existing ones.

---

## Video Clips

The plugin will display video clips from Arlo Cloud for cameras with cloud recording enabled.

- Clips are streamed on-demand, not downloaded to your Scrypted server.
- To delete clips, use the Arlo App or My Arlo Web Dashboard.
