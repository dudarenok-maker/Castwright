package ai.castwright

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import java.io.File

/**
 * app-9: serves local cover thumbnails as `content://` so Android Auto's host
 * process (a separate process) can render covers in the projection's now-playing
 * screen + browse rows. A private `file://` only renders in-process (notification
 * / native widget), which is why covers were missing in the AA projection.
 *
 * Exported with NO permission because book covers are public, zero-sensitivity
 * images — and it's the only headless-safe option (a manifest component is
 * available even when AA browses without the Flutter UI engine, and per-URI
 * grants aren't possible from that headless context). Hardened against abuse:
 * only image files inside a `thumbs/` directory under THIS app's data dir are
 * served, so settings.json / the SQLite DB can never be read even though they
 * live under the same data dir, and path traversal is blocked via canonical paths.
 *
 * URI shape (built in Dart, see art_uri.dart):
 *   content://ai.castwright.art/cover?path=<absolute thumbnail file path>
 */
class ArtContentProvider : ContentProvider() {
    override fun onCreate(): Boolean = true

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor? {
        val path = uri.getQueryParameter("path") ?: return null
        val ctx = context ?: return null
        val file = File(path).canonicalFile
        val dataDir = File(ctx.applicationInfo.dataDir).canonicalFile
        val ok = file.path.startsWith(dataDir.path + File.separator) &&
            file.path.contains("${File.separator}thumbs${File.separator}") &&
            file.isFile &&
            IMAGE_EXTS.any { file.name.endsWith(it, ignoreCase = true) }
        if (!ok) return null
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun getType(uri: Uri): String = "image/jpeg"

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor? = null

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null

    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<out String>?,
    ): Int = 0

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

    companion object {
        private val IMAGE_EXTS = listOf(".jpg", ".jpeg", ".png", ".webp")
    }
}
