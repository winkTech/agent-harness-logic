function bits = mod_demapper(symbols, mod_type)
%% 解调映射 (**硬判决**)
%  输入: symbols  - 接收符号 [N x 1]
%        mod_type - 'BPSK'|'QPSK'|'16QAM'|'64QAM'
%  输出: bits - 解调比特 (0/1)
%
%  注释修正 (2026-08-05, owner 裁定⑥): 原头注释写"软判决"与实现不符 —— 本函数逐比特
%  取阈值判决后返回 0/1, 是**硬判决**。**行为未改**, rx_chain / test_ber 继续依赖它。
%  需要软信息的下游 (cbb/ldpc_codec 吃 LLR Q(10,4) + 归一化 Min-Sum) 请用同目录的
%  src/mod_demapper_llr.m —— 硬比特喂不进软译码器。
%
%  符号约定 (与 mod_mapper 一致): s = 2b - 1, 即 y >= 0 判为 **bit 1**。
%  注意 models/comm/ldpc 侧用的是相反约定 (s = 1 - 2c, 正 LLR = bit 0),
%  mod_demapper_llr 已按下游需要翻号, 详见其头注释。

    switch mod_type
        case 'BPSK'
            bits = real(symbols) >= 0;

        case 'QPSK'
            I = real(symbols);
            Q = imag(symbols);
            bits = zeros(2*length(symbols), 1);
            bits(1:2:end) = I >= 0;
            bits(2:2:end) = Q >= 0;

        case '16QAM'
            scale = sqrt(10);
            s = symbols * scale;
            I = real(s);
            Q = imag(s);
            N = length(symbols);
            bits = zeros(4*N, 1);
            bits(1:4:end) = I >= 0;           % b0
            bits(2:4:end) = abs(I) <= 2;       % b1 (简化判决)
            bits(3:4:end) = Q >= 0;           % b2
            bits(4:4:end) = abs(Q) <= 2;       % b3

        case '64QAM'
            scale = sqrt(42);
            s = symbols * scale;
            I = real(s);
            Q = imag(s);
            N = length(symbols);
            bits = zeros(6*N, 1);
            bits(1:6:end) = I >= 0;
            bits(2:6:end) = abs(I) <= 4;
            bits(3:6:end) = abs(abs(I)-4) <= 2;
            bits(4:6:end) = Q >= 0;
            bits(5:6:end) = abs(Q) <= 4;
            bits(6:6:end) = abs(abs(Q)-4) <= 2;

        otherwise
            error('不支持的调制方式: %s', mod_type);
    end
    bits = double(bits(:));
end
