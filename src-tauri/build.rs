use std::path::Path;

fn main() {
    // `resources/bin` is filled per build by the beforeBundleCommand hook,
    // which runs long after this point — but tauri_build::build() checks that
    // every `resources` path in tauri.conf.json exists, and refuses to compile
    // when one does not. The directory is therefore created here, before that
    // check, so a fresh clone builds without anything having to be committed
    // inside a folder whose whole contents are generated.
    //
    // It used to be held open by a committed .gitkeep instead. That worked,
    // but the file sat at the root of a directory Tauri copies wholesale into
    // the bundle, so every installer shipped a stray .gitkeep.
    let staging = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join("bin");
    if let Err(error) = std::fs::create_dir_all(&staging) {
        panic!("could not create the ffmpeg staging directory {staging:?}: {error}");
    }

    tauri_build::build()
}
