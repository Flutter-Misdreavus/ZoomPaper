use std::sync::Mutex;
use tauri::{Emitter, Manager};
#[derive(Clone, serde::Deserialize)]
pub struct HitRegion {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    ellipse: bool,
    #[serde(default)]
    pet: bool,
}
impl HitRegion {
    fn contains(&self, x: f64, y: f64) -> bool {
        if self.width <= 0.0 || self.height <= 0.0 {
            return false;
        }
        let dx = (x - self.x) / self.width;
        let dy = (y - self.y) / self.height;
        if self.pet {
            pet_contains(dx * 100.0, dy * 100.0)
        } else if self.ellipse {
            (dx - 0.5).powi(2) * 4.0 + (dy - 0.5).powi(2) * 4.0 <= 1.0
        } else {
            (0.0..=1.0).contains(&dx) && (0.0..=1.0).contains(&dy)
        }
    }
}
// Matches the visible SVG silhouette, including ears, wings and feet, excluding the shadow.
fn pet_contains(x: f64, y: f64) -> bool {
    let points = [
        (17., 33.),
        (31., 16.),
        (44., 28.),
        (56., 28.),
        (69., 16.),
        (83., 33.),
        (86., 59.),
        (75., 74.),
        (73., 87.),
        (65., 87.),
        (62., 80.),
        (38., 80.),
        (35., 87.),
        (27., 87.),
        (25., 74.),
        (14., 61.),
    ];
    let mut inside = false;
    for (i, &(ax, ay)) in points.iter().enumerate() {
        let (bx, by) = points[(i + 1) % points.len()];
        if (ay > y) != (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax {
            inside = !inside;
        }
    }
    inside
}
#[derive(Default)]
pub struct Regions(Mutex<Vec<HitRegion>>);
#[derive(Default)]
pub struct Drag(Mutex<Option<DragState>>);
struct DragState {
    cursor: tauri::PhysicalPosition<f64>,
    origin: tauri::PhysicalPosition<i32>,
    moved: bool,
}
impl DragState {
    fn position(
        &mut self,
        cursor: tauri::PhysicalPosition<f64>,
    ) -> Option<tauri::PhysicalPosition<i32>> {
        let dx = cursor.x - self.cursor.x;
        let dy = cursor.y - self.cursor.y;
        self.moved |= dx.hypot(dy) >= 1.0;
        self.moved.then(|| {
            tauri::PhysicalPosition::new(
                (self.origin.x as f64 + dx).round() as i32,
                (self.origin.y as f64 + dy).round() as i32,
            )
        })
    }
}
// The OS button state ends a drag even if WebView loses its pointer-up event.
#[cfg(target_os = "macos")]
fn left_pressed() -> Option<bool> {
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
    }
    Some(unsafe { CGEventSourceButtonState(1, 0) })
}
#[cfg(target_os = "windows")]
fn left_pressed() -> Option<bool> {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetAsyncKeyState(key: i32) -> i16;
    }
    Some(unsafe { GetAsyncKeyState(1) } < 0)
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn left_pressed() -> Option<bool> {
    None
}
#[tauri::command]
pub fn companion_regions(
    window: tauri::WebviewWindow,
    state: tauri::State<Regions>,
    regions: Vec<HitRegion>,
) -> Result<(), String> {
    if window.label() != "companion" {
        return Err("Invalid window".into());
    }
    *state.0.lock().map_err(|e| e.to_string())? = regions;
    Ok(())
}
#[tauri::command]
pub fn companion_press(
    window: tauri::WebviewWindow,
    regions: tauri::State<Regions>,
    drag: tauri::State<Drag>,
    x: f64,
    y: f64,
) -> Result<(), String> {
    if window.label() != "companion" {
        return Err("Invalid window".into());
    }
    if !regions
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .iter()
        .any(|r| r.pet && r.contains(x, y))
    {
        return Ok(());
    }
    let origin = window.outer_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    *drag.0.lock().map_err(|e| e.to_string())? = Some(DragState {
        cursor: tauri::PhysicalPosition::new(
            origin.x as f64 + x * scale,
            origin.y as f64 + y * scale,
        ),
        origin,
        moved: false,
    });
    Ok(())
}
#[tauri::command]
pub fn companion_release(
    window: tauri::WebviewWindow,
    drag: tauri::State<Drag>,
) -> Result<(), String> {
    if window.label() != "companion" {
        return Err("Invalid window".into());
    }
    finish(&window, &drag);
    Ok(())
}
fn finish(window: &tauri::WebviewWindow, drag: &Drag) {
    if let Some(state) = drag.0.lock().ok().and_then(|mut d| d.take()) {
        let _ = window.emit("companion:gesture-end", state.moved);
    }
}
pub fn start(app: tauri::AppHandle) {
    app.manage(Regions::default());
    app.manage(Drag::default());
    std::thread::spawn(move || {
        let mut previous = None;
        loop {
            let Some(window) = app.get_webview_window("companion") else {
                break;
            };
            let drag = app.state::<Drag>();
            if !window.is_visible().unwrap_or(false) {
                finish(&window, &drag);
            } else {
                if left_pressed() == Some(false) {
                    finish(&window, &drag);
                }
                if let (Ok(cursor), Ok(scale)) = (app.cursor_position(), window.scale_factor()) {
                    let mut moving = false;
                    if let Ok(mut gesture) = drag.0.lock() {
                        if let Some(state) = gesture.as_mut() {
                            moving = true;
                            let was_moved = state.moved;
                            if let Some(position) = state.position(cursor) {
                                let _ = window.set_position(position);
                            }
                            if state.moved && !was_moved {
                                let _ = window.emit("companion:gesture-dragging", ());
                            }
                        }
                    }
                    if let Ok(position) = window.outer_position() {
                        let x = (cursor.x - position.x as f64) / scale;
                        let y = (cursor.y - position.y as f64) / scale;
                        let hit = moving
                            || app
                                .state::<Regions>()
                                .0
                                .lock()
                                .map(|rs| rs.iter().any(|r| r.contains(x, y)))
                                .unwrap_or(false);
                        if previous != Some(hit) {
                            if window.set_ignore_cursor_events(!hit).is_ok() {
                                previous = Some(hit);
                                let _ = window.emit("companion:pointer-region", hit);
                            }
                        }
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transparent_corners_pass_through() {
        let r = HitRegion {
            x: 10.,
            y: 10.,
            width: 76.,
            height: 76.,
            ellipse: true,
            pet: false,
        };
        assert!(r.contains(48., 48.));
        assert!(!r.contains(10., 10.));
        assert!(!r.contains(90., 48.));
    }
    #[test]
    fn rectangular_controls_include_edges() {
        let r = HitRegion {
            x: 0.,
            y: 0.,
            width: 30.,
            height: 20.,
            ellipse: false,
            pet: false,
        };
        assert!(r.contains(30., 20.));
        assert!(!r.contains(-1., 10.));
    }
    #[test]
    fn pet_includes_ears_wings_feet_but_never_blank_window_space() {
        for (x, y) in [
            (31., 21.),
            (69., 21.),
            (50., 46.),
            (21., 60.),
            (79., 60.),
            (30., 84.),
            (70., 84.),
            (50., 74.),
        ] {
            assert!(pet_contains(x, y), "{x},{y}");
        }
        for (x, y) in [
            (0., 0.),
            (50., 5.),
            (5., 50.),
            (95., 50.),
            (50., 95.),
            (0., 99.),
        ] {
            assert!(!pet_contains(x, y), "{x},{y}");
        }
    }
    #[test]
    fn drag_uses_original_screen_position_and_keeps_tracking_outside_window() {
        let mut drag = DragState {
            cursor: tauri::PhysicalPosition::new(200., 100.),
            origin: tauri::PhysicalPosition::new(170, 80),
            moved: false,
        };
        assert!(drag
            .position(tauri::PhysicalPosition::new(200., 100.))
            .is_none());
        assert_eq!(
            drag.position(tauri::PhysicalPosition::new(201., 100.)),
            Some(tauri::PhysicalPosition::new(171, 80))
        );
        assert_eq!(
            drag.position(tauri::PhysicalPosition::new(210., 115.)),
            Some(tauri::PhysicalPosition::new(180, 95))
        );
        assert_eq!(
            drag.position(tauri::PhysicalPosition::new(-400., 700.)),
            Some(tauri::PhysicalPosition::new(-430, 680))
        );
        assert!(drag.moved);
    }
}
