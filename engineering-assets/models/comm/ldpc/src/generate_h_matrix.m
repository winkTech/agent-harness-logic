function H = generate_h_matrix(cfg)
% <LDPC> 生成 802.11n QC-LDPC 校验矩阵
% 输入:
%   cfg - 配置结构体 (含 .Z, .P)
% 输出:
%   H   - 稀疏校验矩阵 [M×N] (logical/double)
%
% 使用 ldpcQuasiCyclicMatrix 将原型矩阵展开为完整 H 矩阵

    H = ldpcQuasiCyclicMatrix(cfg.Z, cfg.P);
end
