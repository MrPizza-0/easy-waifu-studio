"""Connect a phone: a page with a QR code of the phone app's address, and a Windows tray icon that opens it.

The address is the first one the phone can actually reach:
  1. `tailscale serve` HTTPS address that points at this ComfyUI
  2. this PC's Tailscale IP (needs --listen)
  3. this PC's home network IP (needs --listen, phone on the same Wi-Fi)
Turn the tray icon off with "tray": false in ComfyUI/user/waifu_studio.json.
"""
import asyncio
import ctypes
import html
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import webbrowser

from aiohttp import web
from server import PromptServer
from comfy.cli_args import args

from .downloads import load_config

HERE = os.path.dirname(os.path.abspath(__file__))
NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0


def _tailscale(*cmd):
    exe = shutil.which("tailscale") or r"C:\Program Files\Tailscale\tailscale.exe"
    if not os.path.isfile(exe) and not shutil.which("tailscale"):
        return None
    try:
        out = subprocess.run([exe, *cmd, "--json"], capture_output=True, timeout=4, creationflags=NO_WINDOW)
        return json.loads(out.stdout) if out.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None


def _lan_ip():
    # connecting a UDP socket sends nothing; it only asks the OS which local address it would use
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()
    return None if ip.startswith(("127.", "100.")) else ip


def addresses():
    """[(label, url)], best first, plus a problem text when none works."""
    port = args.port
    listening = args.listen not in ("127.0.0.1", "localhost", "::1")
    out = []
    serve = _tailscale("serve", "status") or {}
    for host, web_cfg in (serve.get("Web") or {}).items():
        for path, h in (web_cfg.get("Handlers") or {}).items():
            if (h.get("Proxy") or "").rstrip("/").endswith(f":{port}"):
                base = "https://" + host.removesuffix(":443")
                out.append(("Tailscale (HTTPS)", base + path.rstrip("/") + "/waifu/m/"))
    status = _tailscale("status") or {}
    ts_ip = next((ip for ip in (status.get("Self") or {}).get("TailscaleIPs", []) if "." in ip), None)
    if listening and ts_ip:
        out.append(("Tailscale", f"http://{ts_ip}:{port}/waifu/m/"))
    lan = _lan_ip() if listening else None
    if lan:
        out.append(("Home Wi-Fi", f"http://{lan}:{port}/waifu/m/"))
    problem = None
    if not out:
        problem = (f"ComfyUI only accepts connections from this PC, so a phone can't reach it. Either run "
                   f"<code>tailscale serve --bg {port}</code> once (recommended, see the README), or start ComfyUI "
                   f"with <code>--listen</code>.")
    return out, problem


def qr_svg(text):
    try:
        import qrcode
    except ImportError:
        return None
    q = qrcode.QRCode(border=2, error_correction=qrcode.constants.ERROR_CORRECT_M)
    q.add_data(text)
    m = q.get_matrix()
    n = len(m)
    path = "".join(f"M{x},{y}h1v1h-1z" for y, row in enumerate(m) for x, on in enumerate(row) if on)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {n} {n}" shape-rendering="crispEdges">'
            f'<rect width="{n}" height="{n}" fill="#fff"/><path d="{path}" fill="#000"/></svg>')


PAGE = """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect your phone · Waifu Studio</title><link rel="icon" href="/waifu/m/s/icon.svg">
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d0b12;color:#ece8f3;
font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.card{background:#15121c;border:1px solid #2d2739;border-radius:20px;padding:28px;width:min(420px,92vw);text-align:center}
h1{font-size:20px;margin:0 0 18px}
.qr{background:#fff;border-radius:14px;padding:10px;width:260px;height:260px;margin:0 auto}
.qr svg{width:100%;height:100%;display:block}
.tabs{display:flex;gap:6px;justify-content:center;margin:0 0 16px;flex-wrap:wrap}
.tabs a{padding:6px 12px;border-radius:999px;border:1px solid #3a3249;color:#cfc8dc;text-decoration:none;font-size:13px}
.tabs a.on{background:rgba(255,111,174,.14);border-color:rgba(255,111,174,.45);color:#ff6fae}
.url{margin:14px 0 4px;font:13px ui-monospace,Consolas,monospace;color:#ff6fae;word-break:break-all}
code{background:#262033;padding:2px 6px;border-radius:6px}
.warn{color:#ffcf6e;text-align:left}
</style></head><body><div class="card">@BODY@</div></body></html>"""


def page(choice=0):
    found, problem = addresses()
    if problem:
        return PAGE.replace("@BODY@", f'<h1>Connect your phone</h1><p class="warn">{problem}</p>')
    choice = min(max(choice, 0), len(found) - 1)
    label, url = found[choice]
    svg = qr_svg(url)
    tabs = "".join(f'<a href="?a={i}" class="{"on" if i == choice else ""}">{html.escape(l)}</a>' for i, (l, _) in enumerate(found))
    qr = f'<div class="qr">{svg}</div>' if svg else '<p class="warn">The QR code needs the "qrcode" package: <code>pip install qrcode</code>. Type the address below into your phone instead.</p>'
    return PAGE.replace("@BODY@", f'<h1>Connect your phone</h1>'
                   f'{"<div class=tabs>" + tabs + "</div>" if len(found) > 1 else ""}{qr}'
                   f'<div class="url">{html.escape(url)}</div>')


# ------------------------------------------------------------------ Windows tray icon
def _tray():
    from ctypes import wintypes as w
    u32, sh, k32 = ctypes.windll.user32, ctypes.windll.shell32, ctypes.windll.kernel32
    LRESULT = ctypes.c_ssize_t
    WNDPROC = ctypes.WINFUNCTYPE(LRESULT, w.HWND, w.UINT, w.WPARAM, w.LPARAM)
    u32.DefWindowProcW.argtypes = [w.HWND, w.UINT, w.WPARAM, w.LPARAM]
    u32.DefWindowProcW.restype = LRESULT
    u32.CreateWindowExW.restype = w.HWND
    u32.CreateWindowExW.argtypes = [w.DWORD, w.LPCWSTR, w.LPCWSTR, w.DWORD, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                    ctypes.c_int, w.HWND, w.HMENU, w.HINSTANCE, w.LPVOID]
    u32.LoadImageW.restype = w.HANDLE
    u32.LoadImageW.argtypes = [w.HINSTANCE, w.LPCWSTR, w.UINT, ctypes.c_int, ctypes.c_int, w.UINT]
    u32.CreatePopupMenu.restype = w.HMENU
    u32.AppendMenuW.argtypes = [w.HMENU, w.UINT, ctypes.c_size_t, w.LPCWSTR]
    u32.TrackPopupMenu.argtypes = [w.HMENU, w.UINT, ctypes.c_int, ctypes.c_int, ctypes.c_int, w.HWND, w.LPVOID]
    u32.SetForegroundWindow.argtypes = [w.HWND]
    u32.DestroyMenu.argtypes = [w.HMENU]
    k32.GetModuleHandleW.restype = w.HMODULE

    class WNDCLASSW(ctypes.Structure):
        _fields_ = [("style", w.UINT), ("lpfnWndProc", WNDPROC), ("cbClsExtra", ctypes.c_int), ("cbWndExtra", ctypes.c_int),
                    ("hInstance", w.HINSTANCE), ("hIcon", w.HICON), ("hCursor", w.HANDLE), ("hbrBackground", w.HBRUSH),
                    ("lpszMenuName", w.LPCWSTR), ("lpszClassName", w.LPCWSTR)]

    class NOTIFYICONDATAW(ctypes.Structure):
        _fields_ = [("cbSize", w.DWORD), ("hWnd", w.HWND), ("uID", w.UINT), ("uFlags", w.UINT), ("uCallbackMessage", w.UINT),
                    ("hIcon", w.HICON), ("szTip", w.WCHAR * 128), ("dwState", w.DWORD), ("dwStateMask", w.DWORD),
                    ("szInfo", w.WCHAR * 256), ("uVersion", w.UINT), ("szInfoTitle", w.WCHAR * 64), ("dwInfoFlags", w.DWORD),
                    ("guidItem", ctypes.c_byte * 16), ("hBalloonIcon", w.HICON)]

    sh.Shell_NotifyIconW.argtypes = [w.DWORD, ctypes.POINTER(NOTIFYICONDATAW)]
    WM_TRAY, WM_LBUTTONUP, WM_RBUTTONUP, WM_COMMAND = 0x8001, 0x0202, 0x0205, 0x0111
    NIM_ADD, NIM_DELETE, NIF_MESSAGE, NIF_ICON, NIF_TIP = 0, 2, 1, 2, 4
    CONNECT = 1
    url = f"http://127.0.0.1:{args.port}/waifu/connect"
    taskbar_created = u32.RegisterWindowMessageW("TaskbarCreated")

    ico = os.path.join(HERE, ".cache", "tray.ico")
    if not os.path.isfile(ico):
        from PIL import Image
        os.makedirs(os.path.dirname(ico), exist_ok=True)
        Image.open(os.path.join(HERE, "mobile", "icon-192.png")).save(ico, sizes=[(16, 16), (24, 24), (32, 32), (48, 48)])

    nid = NOTIFYICONDATAW()

    def add():
        sh.Shell_NotifyIconW(NIM_ADD, ctypes.byref(nid))

    def menu(hwnd):
        m = u32.CreatePopupMenu()
        u32.AppendMenuW(m, 0, CONNECT, "Connect phone")
        pt = w.POINT()
        u32.GetCursorPos(ctypes.byref(pt))
        u32.SetForegroundWindow(hwnd)  # without this the menu doesn't close when you click elsewhere
        cmd = u32.TrackPopupMenu(m, 0x0100 | 0x0020, pt.x, pt.y, 0, hwnd, None)  # TPM_RETURNCMD | TPM_BOTTOMALIGN
        u32.DestroyMenu(m)
        if cmd == CONNECT:
            webbrowser.open(url)

    def proc(hwnd, msg, wp, lp):
        if msg == WM_TRAY:
            if lp == WM_LBUTTONUP:
                webbrowser.open(url)
            elif lp == WM_RBUTTONUP:
                menu(hwnd)
            return 0
        if msg == taskbar_created:  # Explorer restarted: put the icon back
            add()
            return 0
        return u32.DefWindowProcW(hwnd, msg, wp, lp)

    wndproc = WNDPROC(proc)
    hinst = k32.GetModuleHandleW(None)
    wc = WNDCLASSW(lpfnWndProc=wndproc, hInstance=hinst, lpszClassName=f"WaifuStudioTray{args.port}")
    u32.RegisterClassW(ctypes.byref(wc))
    hwnd = u32.CreateWindowExW(0, wc.lpszClassName, "Waifu Studio", 0, 0, 0, 0, 0, None, None, hinst, None)
    nid.cbSize, nid.hWnd, nid.uID = ctypes.sizeof(NOTIFYICONDATAW), hwnd, 1
    nid.uFlags, nid.uCallbackMessage = NIF_MESSAGE | NIF_ICON | NIF_TIP, WM_TRAY
    nid.hIcon = u32.LoadImageW(None, ico, 1, 0, 0, 0x10 | 0x40)  # IMAGE_ICON, LR_LOADFROMFILE | LR_DEFAULTSIZE
    nid.szTip = f"Waifu Studio (port {args.port})"
    add()
    import atexit
    atexit.register(lambda: sh.Shell_NotifyIconW(NIM_DELETE, ctypes.byref(nid)))
    msg = w.MSG()
    while u32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
        u32.TranslateMessage(ctypes.byref(msg))
        u32.DispatchMessageW(ctypes.byref(msg))


def register_routes():
    routes = PromptServer.instance.routes

    @routes.get("/waifu/connect")
    async def connect_page(request):
        try:
            choice = int(request.query.get("a", 0))
        except ValueError:
            choice = 0
        return web.Response(text=await asyncio.to_thread(page, choice), content_type="text/html", headers={"Cache-Control": "no-store"})

    if sys.platform == "win32" and load_config().get("tray", True):
        threading.Thread(target=_run_tray, name="waifu-studio-tray", daemon=True).start()


def _run_tray():
    try:
        _tray()
    except Exception as ex:
        print(f"[waifu_studio] tray icon not available: {ex}")
