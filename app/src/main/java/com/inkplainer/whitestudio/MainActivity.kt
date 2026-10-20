package com.inkplainer.whitestudio

import android.app.Activity
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import java.io.ByteArrayInputStream

/** Minimal M1 host used to verify the packaged WebView origin and portrait touch input. */
class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var errorView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain(WebViewAssetLoader.DEFAULT_DOMAIN)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            setBackgroundColor(Color.WHITE)
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = false
                databaseEnabled = false
                allowFileAccess = false
                allowContentAccess = false
                allowFileAccessFromFileURLs = false
                allowUniversalAccessFromFileURLs = false
                javaScriptCanOpenWindowsAutomatically = false
                setSupportMultipleWindows(false)
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                mediaPlaybackRequiresUserGesture = true
                safeBrowsingEnabled = true
                builtInZoomControls = false
                displayZoomControls = false
            }
            webViewClient = object : WebViewClientCompat() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest
                ): WebResourceResponse {
                    return localAssetResponse(assetLoader, request.url)
                }

                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest
                ): Boolean {
                    // The app has no remote navigation path. All document navigation stays local.
                    return !isPackagedOrigin(request.url)
                }

                override fun onReceivedError(
                    view: WebView,
                    request: WebResourceRequest,
                    error: android.webkit.WebResourceError
                ) {
                    if (request.isForMainFrame) showLoadError()
                }
            }
        }

        errorView = TextView(this).apply {
            text = "The bundled diagnostic page could not be loaded. Reinstall the APK or check the build artifact."
            textSize = 16f
            setTextColor(Color.rgb(43, 50, 65))
            gravity = Gravity.CENTER
            setPadding(32, 32, 32, 32)
            visibility = View.GONE
        }

        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.WHITE)
            addView(
                webView,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            )
            addView(
                errorView,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            )
        }
        setContentView(root)
        webView.loadUrl(DIAGNOSTIC_URL)
    }

    override fun onResume() {
        super.onResume()
        if (::webView.isInitialized) webView.onResume()
    }

    override fun onPause() {
        if (::webView.isInitialized) webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        if (::webView.isInitialized) {
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.stopLoading()
            webView.destroy()
        }
        super.onDestroy()
    }

    private fun isPackagedOrigin(uri: Uri): Boolean =
        uri.scheme == "https" && uri.host == WebViewAssetLoader.DEFAULT_DOMAIN

    private fun localAssetResponse(
        assetLoader: WebViewAssetLoader,
        uri: Uri
    ): WebResourceResponse {
        if (!isPackagedOrigin(uri)) {
            return blockedResponse(403, "Blocked", "External WebView requests are disabled.")
        }
        return assetLoader.shouldInterceptRequest(uri)
            ?: blockedResponse(404, "Not Found", "Packaged asset not found.")
    }

    private fun blockedResponse(
        statusCode: Int,
        reason: String,
        message: String
    ): WebResourceResponse = WebResourceResponse(
        "text/plain",
        "UTF-8",
        statusCode,
        reason,
        mapOf("Cache-Control" to "no-store"),
        ByteArrayInputStream(message.toByteArray(Charsets.UTF_8))
    )

    private fun showLoadError() {
        runOnUiThread {
            if (::webView.isInitialized && ::errorView.isInitialized) {
                webView.visibility = View.GONE
                errorView.visibility = View.VISIBLE
            }
        }
    }

    private companion object {
        val DIAGNOSTIC_URL =
            "https://${WebViewAssetLoader.DEFAULT_DOMAIN}/assets/www/diagnostic.html"
    }
}
