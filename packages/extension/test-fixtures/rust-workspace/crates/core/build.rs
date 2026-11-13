macro_rules! emit_label {
    () => {
        "core"
    };
}

macro_rules! hide {
    ($($token:tt)*) => {};
}

fn main() {
    println!("cargo:rerun-if-changed=src/lib.rs");
    let _label = emit_label!();
}

fn configured() {
    hide! { fn not_a_real_item() {} }
    let _path = concat!("src/", "lib.rs");
}
