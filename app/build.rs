fn main() {
    let config = slint_build::CompilerConfiguration::new().with_style("fluent-dark".into());
    slint_build::compile_with_config("ui/app.slint", config).expect("the interface files must compile");

    // The icon and details Windows shows for the program file.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("assets/logo.ico");
        res.set("ProductName", "Make Video Small");
        res.set("FileDescription", "Make Video Small");
        if let Err(e) = res.compile() {
            println!("cargo:warning=could not add the program icon: {e}");
        }
    }
}
