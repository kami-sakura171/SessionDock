//! 数据一致性对比用的小工具（只读，不写任何平台数据）：
//!   cargo run --example scan                       -> 全平台会话列表 JSON
//!   cargo run --example scan -- --read <平台> <id>  -> 单个会话的消息 JSON

use session_dock_core::sessions;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 4 && args[1] == "--read" {
        match sessions::read(&args[2], &args[3]) {
            Ok(msgs) => println!("{}", serde_json::to_string(&msgs).unwrap()),
            Err(e) => {
                eprintln!("read error: {e}");
                std::process::exit(1);
            }
        }
        return;
    }
    let data = sessions::list_all();
    println!("{}", serde_json::to_string(&data).unwrap());
}
