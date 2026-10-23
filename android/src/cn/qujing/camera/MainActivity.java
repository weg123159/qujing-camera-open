package cn.qujing.camera;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Offline-only host: bundled HTTPS origin is intercepted before any network access. */
public final class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String PREFIX = "/www/";
    private static final String START_URL = "https://" + HOST + PREFIX + "index.html";
    private static final int CAMERA_REQUEST = 110, PICK_IMAGE = 111, SAVE_PHOTO = 112;
    private static final int MAX_PHOTO_BYTES = 24 * 1024 * 1024;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private WebView webView;
    private PermissionRequest pendingCamera;
    private ValueCallback<Uri[]> pendingPicker;
    private byte[] pendingPhoto;
    private String pendingSaveId;
    private boolean destroyed;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Own the safe-area padding consistently before and after Android 15 edge-to-edge.
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        else getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(17, 28, 24));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets safe = insets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(17, 28, 24));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        root.requestApplyInsets();

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true); // Android image picker content:// input only.
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setBlockNetworkLoads(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        // Camera starts from an explicit page action and Android permission. Its muted
        // preview must still play after those async operations consume transient activation.
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setGeolocationEnabled(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        CookieManager.getInstance().setAcceptCookie(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        WebView.setWebContentsDebuggingEnabled(false);
        webView.addJavascriptInterface(new NativeBridge(), "QujingNative");
        webView.setWebViewClient(new LocalClient());
        webView.setWebChromeClient(new CameraChromeClient());
        // SWs are not needed for bundled mode; even an accidental registration cannot use network.
        ServiceWorkerController controller = ServiceWorkerController.getInstance();
        controller.getServiceWorkerWebSettings().setBlockNetworkLoads(true);
        controller.getServiceWorkerWebSettings().setAllowFileAccess(false);
        controller.setServiceWorkerClient(new ServiceWorkerClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                return intercept(request.getUrl(), request.getMethod());
            }
        });
        webView.loadUrl(START_URL);
    }

    private boolean trusted(Uri uri) {
        return uri != null && "https".equals(uri.getScheme()) && HOST.equals(uri.getHost())
            && uri.getPort() == -1 && uri.getUserInfo() == null;
    }

    private boolean trustedPage() {
        return !destroyed && webView != null && trusted(Uri.parse(String.valueOf(webView.getUrl())));
    }

    private WebResourceResponse textError(int code, String reason) {
        return new WebResourceResponse("text/plain", "UTF-8", code, reason,
            Collections.singletonMap("Cache-Control", "no-store"),
            new ByteArrayInputStream(reason.getBytes(StandardCharsets.UTF_8)));
    }

    /** Small framework-only equivalent of an assets path handler; never falls through to network. */
    private WebResourceResponse intercept(Uri uri, String method) {
        if (!trusted(uri) || !"GET".equals(method)) return textError(403, "Offline resource only");
        String path = uri.getPath();
        if (path == null || !path.startsWith(PREFIX) || path.contains("\\") || path.contains("\0"))
            return textError(403, "Invalid asset path");
        for (String part : path.split("/"))
            if (part.equals(".") || part.equals("..")) return textError(403, "Invalid asset path");
        String asset = path.substring(1);
        if (path.equals(PREFIX)) asset += "index.html";
        try {
            InputStream data = getAssets().open(asset);
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            headers.put("X-Content-Type-Options", "nosniff");
            headers.put("Referrer-Policy", "no-referrer");
            headers.put("Content-Security-Policy", "default-src 'self' data: blob:; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-src 'none'");
            return new WebResourceResponse(mime(asset), "UTF-8", 200, "OK", headers, data);
        } catch (IOException error) { return textError(404, "Bundled asset missing"); }
    }

    private String mime(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".mjs") || p.endsWith(".js")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".webmanifest")) return "application/manifest+json";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    private final class LocalClient extends WebViewClient {
        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            return intercept(request.getUrl(), request.getMethod());
        }
        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (trusted(request.getUrl()) && request.getUrl().getPath().startsWith(PREFIX)) return false;
            if (request.isForMainFrame()) Toast.makeText(MainActivity.this,
                "离线版不打开外部网页", Toast.LENGTH_SHORT).show();
            return true;
        }
    }

    private final class CameraChromeClient extends WebChromeClient {
        @Override public void onPermissionRequest(PermissionRequest request) {
            runOnUiThread(() -> {
                if (destroyed || !trusted(request.getOrigin())
                    || !Arrays.asList(request.getResources()).contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
                    request.deny(); return;
                }
                if (pendingCamera != null) pendingCamera.deny();
                pendingCamera = request;
                if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    pendingCamera = null;
                    request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                } else requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_REQUEST);
            });
        }
        @Override public void onPermissionRequestCanceled(PermissionRequest request) {
            runOnUiThread(() -> { if (pendingCamera == request) pendingCamera = null; });
        }
        @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                                   FileChooserParams params) {
            if (!trustedPage()) { callback.onReceiveValue(null); return true; }
            if (pendingPicker != null) pendingPicker.onReceiveValue(null);
            pendingPicker = callback;
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.setType("image/*");
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/jpeg", "image/png", "image/webp"});
            try { startActivityForResult(intent, PICK_IMAGE); }
            catch (ActivityNotFoundException error) {
                pendingPicker = null; callback.onReceiveValue(null);
                Toast.makeText(MainActivity.this, "设备没有可用的图片选择器", Toast.LENGTH_LONG).show();
            }
            return true;
        }
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(code, permissions, grants);
        if (code != CAMERA_REQUEST || pendingCamera == null) return;
        PermissionRequest request = pendingCamera; pendingCamera = null;
        if (!destroyed && trustedPage() && grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED)
            request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        else request.deny();
    }

    private final class NativeBridge {
        @JavascriptInterface public String getInfo() {
            return "{\"platform\":\"android\",\"version\":\"0.6.0\",\"bundledOffline\":true,\"networkPermission\":false,\"savePhoto\":true}";
        }
        @JavascriptInterface public void savePhoto(String dataUrl, String requestId) {
            runOnUiThread(() -> startPhotoSave(dataUrl, requestId));
        }
    }

    private void startPhotoSave(String dataUrl, String requestId) {
        if (!trustedPage()) return;
        if (requestId == null || !requestId.matches("[A-Za-z0-9_-]{1,80}")) return;
        if (pendingSaveId != null) { saveEvent(requestId, "error", "已有照片正在保存，请先完成或取消"); return; }
        if (dataUrl == null || !dataUrl.startsWith("data:image/jpeg;base64,")
            || dataUrl.length() > MAX_PHOTO_BYTES * 4L / 3L + 128) {
            saveEvent(requestId, "error", "只能保存应用生成的 JPEG 照片"); return;
        }
        pendingSaveId = requestId;
        io.execute(() -> {
            try {
                byte[] bytes = Base64.decode(dataUrl.substring(dataUrl.indexOf(',') + 1), Base64.DEFAULT);
                BitmapFactory.Options options = new BitmapFactory.Options(); options.inJustDecodeBounds = true;
                BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
                if (bytes.length < 4 || bytes.length > MAX_PHOTO_BYTES || (bytes[0] & 255) != 255
                    || (bytes[1] & 255) != 216 || options.outWidth < 1 || options.outHeight < 1
                    || options.outWidth > 8192 || options.outHeight > 8192) throw new IOException("Invalid JPEG");
                runOnUiThread(() -> {
                    if (destroyed || !requestId.equals(pendingSaveId)) return;
                    pendingPhoto = bytes;
                    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE); intent.setType("image/jpeg");
                    intent.putExtra(Intent.EXTRA_TITLE, "取景_" + new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.ROOT).format(new Date()) + ".jpg");
                    try { startActivityForResult(intent, SAVE_PHOTO); }
                    catch (ActivityNotFoundException error) { finishSave("error", "设备没有可用的文件保存器"); }
                });
            } catch (RuntimeException | IOException error) {
                runOnUiThread(() -> finishSave("error", "照片编码无效，未保存"));
            }
        });
    }

    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code == PICK_IMAGE) {
            ValueCallback<Uri[]> callback = pendingPicker; pendingPicker = null;
            if (callback != null) callback.onReceiveValue(result == RESULT_OK && data != null && data.getData() != null
                ? new Uri[]{data.getData()} : null);
        } else if (code == SAVE_PHOTO && pendingSaveId != null) {
            if (result != RESULT_OK || data == null || data.getData() == null) {
                finishSave("cancelled", "已取消，照片仍在预览中"); return;
            }
            Uri destination = data.getData(); byte[] bytes = pendingPhoto;
            if (bytes == null || !"content".equals(destination.getScheme())) {
                finishSave("error", "保存目标不可用，照片未写入"); return;
            }
            io.execute(() -> {
                try {
                    try (OutputStream output = getContentResolver().openOutputStream(destination, "w")) {
                        if (output == null) throw new IOException("Missing output stream");
                        output.write(bytes); output.flush();
                    }
                    runOnUiThread(() -> finishSave("saved", "照片已保存到你选择的位置"));
                } catch (IOException | RuntimeException error) {
                    runOnUiThread(() -> finishSave("error", "保存失败，请重新选择位置；照片仍在预览中"));
                }
            });
        }
    }

    private void finishSave(String status, String message) {
        String id = pendingSaveId; pendingSaveId = null; pendingPhoto = null;
        if (id != null) saveEvent(id, status, message);
    }

    private void saveEvent(String id, String status, String message) {
        if (!trustedPage()) return;
        String detail = "{requestId:" + JSONObject.quote(id) + ",status:" + JSONObject.quote(status)
            + ",message:" + JSONObject.quote(message) + "}";
        webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('qujing-native-save',{detail:" + detail + "}));", null);
    }

    @Override public void onBackPressed() {
        if (webView == null || destroyed) { super.onBackPressed(); return; }
        webView.evaluateJavascript("(()=>{const e=new Event('qujing-native-back',{cancelable:true});if(!window.dispatchEvent(e))return true;const a=[...document.querySelectorAll('dialog[open]')];if(a.length){const d=a[a.length-1],c=new Event('cancel',{cancelable:true});if(d.dispatchEvent(c))d.close();return true;}return false;})()",
            handled -> { if (!"true".equals(handled) && !destroyed) MainActivity.super.onBackPressed(); });
    }

    @Override protected void onResume() {
        super.onResume();
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (webView != null) webView.onResume();
    }

    @Override protected void onPause() {
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (webView != null && pendingCamera == null) {
            // The system camera-permission dialog itself can pause this Activity.
            // Keep that pending request alive; backgrounding a running camera still stops it.
            webView.evaluateJavascript("window.dispatchEvent(new Event('qujing-native-pause'));", null);
            webView.onPause();
        }
        super.onPause();
    }

    @Override protected void onStop() {
        // A permission dialog may pause us without stopping us. A genuinely hidden Activity
        // must cancel even that pending request, e.g. Home pressed while the dialog is open.
        if (pendingCamera != null) { pendingCamera.deny(); pendingCamera = null; }
        if (webView != null) {
            webView.evaluateJavascript("window.dispatchEvent(new Event('qujing-native-pause'));", null);
            webView.onPause();
        }
        super.onStop();
    }

    @Override protected void onDestroy() {
        destroyed = true;
        if (pendingCamera != null) { pendingCamera.deny(); pendingCamera = null; }
        if (pendingPicker != null) { pendingPicker.onReceiveValue(null); pendingPicker = null; }
        pendingSaveId = null; pendingPhoto = null; io.shutdown();
        if (webView != null) {
            webView.removeJavascriptInterface("QujingNative"); webView.stopLoading();
            ((FrameLayout) webView.getParent()).removeView(webView); webView.destroy(); webView = null;
        }
        super.onDestroy();
    }
}
