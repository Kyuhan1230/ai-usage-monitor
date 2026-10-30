#[cfg(any(windows, test))]
fn widget_bounds(
    bar: (i32, i32, i32, i32),
    tray: (i32, i32, i32, i32),
) -> Option<(i32, i32, u32, u32)> {
    let height = bar.3 - bar.1;
    if !(24..=120).contains(&height) || bar.2 - bar.0 <= height || tray.0 - bar.0 < 120 {
        return None;
    }
    let widget_height = (height - 8).min(40);
    Some((
        tray.0 - 120,
        bar.1 + (height - widget_height) / 2,
        116,
        widget_height as u32,
    ))
}

#[cfg(any(windows, test))]
fn covers_taskbar(
    bar: (i32, i32, i32, i32),
    front: (i32, i32, i32, i32),
    class: &str,
    maximized: bool,
) -> bool {
    !maximized
        && !matches!(class, "Progman" | "WorkerW")
        && front.0 <= bar.0
        && front.1 <= bar.1
        && front.2 >= bar.2
        && front.3 >= bar.3
}

#[cfg(windows)]
pub fn start(app: tauri::AppHandle) {
    use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowExW, FindWindowW, GW_HWNDPREV, GetClassNameW, GetForegroundWindow, GetWindow,
        GetWindowRect, HWND_TOPMOST, IsZoomed, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SetWindowPos,
    };
    use windows::core::{PCWSTR, w};

    std::thread::spawn(move || {
        let window = match WebviewWindowBuilder::new(
            &app,
            "taskbar-widget",
            WebviewUrl::App("taskbar.html".into()),
        )
        .title("AI usage")
        .inner_size(116.0, 40.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build()
        {
            Ok(window) => window,
            Err(error) => {
                eprintln!("taskbar widget: {error}");
                return;
            }
        };
        let _ = window.set_ignore_cursor_events(true);
        let mut shown = false;
        let mut last_bounds = None;
        loop {
            let bounds = unsafe {
                let shell = FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()).ok();
                shell.and_then(|shell| {
                    let tray =
                        FindWindowExW(Some(shell), None, w!("TrayNotifyWnd"), PCWSTR::null())
                            .ok()?;
                    let mut bar_rect = RECT::default();
                    let mut tray_rect = RECT::default();
                    GetWindowRect(shell, &mut bar_rect).ok()?;
                    GetWindowRect(tray, &mut tray_rect).ok()?;
                    let foreground = GetForegroundWindow();
                    let mut front_rect = RECT::default();
                    let mut class_name = [0u16; 256];
                    let class_length = GetClassNameW(foreground, &mut class_name).max(0) as usize;
                    let class = String::from_utf16_lossy(&class_name[..class_length]);
                    if foreground != shell
                        && GetWindowRect(foreground, &mut front_rect).is_ok()
                        && covers_taskbar(
                            (bar_rect.left, bar_rect.top, bar_rect.right, bar_rect.bottom),
                            (
                                front_rect.left,
                                front_rect.top,
                                front_rect.right,
                                front_rect.bottom,
                            ),
                            &class,
                            IsZoomed(foreground).as_bool(),
                        )
                    {
                        return None;
                    }
                    widget_bounds(
                        (bar_rect.left, bar_rect.top, bar_rect.right, bar_rect.bottom),
                        (
                            tray_rect.left,
                            tray_rect.top,
                            tray_rect.right,
                            tray_rect.bottom,
                        ),
                    )
                })
            };
            if let Some((x, y, width, height)) = bounds {
                if last_bounds != Some((x, y, width, height)) {
                    let size = window.set_size(PhysicalSize::new(width, height));
                    let position = window.set_position(PhysicalPosition::new(x, y));
                    if size.is_ok() && position.is_ok() {
                        last_bounds = Some((x, y, width, height));
                    }
                }
                if !shown {
                    shown = window.show().is_ok();
                }
            } else if shown {
                let _ = window.hide();
                shown = false;
                last_bounds = None;
            }
            // Explorer may raise the taskbar at any time, even above a topmost
            // window. Restore the order promptly, but only when it is wrong.
            for _ in 0..10 {
                if shown && let Ok(widget) = window.hwnd() {
                    unsafe {
                        if let Ok(shell) = FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()) {
                            let mut current = widget;
                            while let Ok(previous) = GetWindow(current, GW_HWNDPREV) {
                                if previous == shell {
                                    let _ = SetWindowPos(
                                        widget,
                                        Some(HWND_TOPMOST),
                                        0,
                                        0,
                                        0,
                                        0,
                                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                                    );
                                    break;
                                }
                                if previous == current {
                                    break;
                                }
                                current = previous;
                            }
                        }
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            if app.get_webview_window("taskbar-widget").is_none() {
                break;
            }
        }
    });
}

#[cfg(not(windows))]
pub fn start(_app: tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn places_readable_widget_immediately_before_the_notification_area() {
        assert_eq!(
            widget_bounds((0, 1392, 2560, 1440), (2298, 1392, 2560, 1440)),
            Some((2178, 1396, 116, 40))
        );
    }

    #[test]
    fn skips_vertical_or_too_small_taskbars() {
        assert_eq!(widget_bounds((0, 0, 48, 1080), (0, 850, 48, 1080)), None);
        assert_eq!(widget_bounds((0, 0, 100, 48), (60, 0, 100, 48)), None);
    }

    #[test]
    fn hides_only_for_fullscreen_apps_not_desktop_or_maximized_windows() {
        let bar = (0, 1392, 2560, 1440);
        assert!(covers_taskbar(
            bar,
            (0, 0, 2560, 1440),
            "Chrome_WidgetWin_1",
            false
        ));
        assert!(!covers_taskbar(
            bar,
            (0, 0, 2560, 1392),
            "Chrome_WidgetWin_1",
            false
        ));
        assert!(!covers_taskbar(bar, (0, 0, 2560, 1440), "Progman", false));
        assert!(!covers_taskbar(bar, (0, 0, 2560, 1440), "WorkerW", false));
    }

    #[test]
    fn maximized_window_with_invisible_borders_is_not_fullscreen() {
        assert!(!covers_taskbar(
            (0, 1392, 2560, 1440),
            (-8, -8, 2568, 1448),
            "Chrome_WidgetWin_1",
            true
        ));
    }
}
