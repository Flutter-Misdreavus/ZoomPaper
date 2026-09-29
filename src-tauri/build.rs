fn main() {
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build();

    // The Linux ONNX Runtime distribution is a static C++ archive. Passing
    // libstdc++ from this top-level build script keeps it after that archive in
    // the final linker command, which GNU linkers require for symbol resolution.
    #[cfg(target_os = "linux")]
    println!("cargo:rustc-link-arg=-lstdc++");
}
