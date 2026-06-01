`timescale 1ns / 1ps
//---------------------------------------------------------------------------------------
//	Project Name	:
//	Module	Name	:ram_2port
//	Build	Date	:
//	Author	Name	:
//	Device	Num		:
//	Project	Intro	:
//
//	Tool	Versions:
//	Add		Comments:
//	
//---------------------------------------------------------------------------------------
//	Revision		By				Time				Updata	Discription
//	
//	Initial			Lihang			2023-07-19			
//---------------------------------------------------------------------------------------


module ram_2port
#(
    parameter DWIDTH=32,
    parameter AWIDTH=9
)
(
    //Port A
    input                   clka        ,
    input                   ena         ,
    input                   wea         ,
    input [AWIDTH-1:0]      addra       ,
    input [DWIDTH-1:0]      dia         ,
    output reg [DWIDTH-1:0] doa         ,

    //Port B
    input                   clkb        ,
    input                   enb         ,
    input                   web         ,
    input [AWIDTH-1:0]      addrb       ,
    input [DWIDTH-1:0]      dib         ,
    output reg [DWIDTH-1:0] dob
);
//---------------------------------------------------------------------------------------
//
//						Signal	Define	
//
//---------------------------------------------------------------------------------------
reg [DWIDTH-1:0] ram [(1<<AWIDTH)-1:0]  ;
integer 	     i                      ;
//---------------------------------------------------------------------------------------
//
//						Ram Initialize	
//
//---------------------------------------------------------------------------------------
initial begin
    for(i=0;i<(1<<AWIDTH);i=i+1)
        ram[i] <= {DWIDTH{1'b0}};
    doa <= 0;
    dob <= 0;
end
//---------------------------------------------------------------------------------------
//
//						PortA Write and Read	
//
//---------------------------------------------------------------------------------------
always @(posedge clka) begin
    if (ena) 
    begin
        if (wea)
            ram[addra] <= dia;
        doa <= ram[addra];
    end
end
//---------------------------------------------------------------------------------------
//
//						PortB Write and Read	
//
//---------------------------------------------------------------------------------------
always @(posedge clkb) begin
    if (enb)
    begin
        if (web)
            ram[addrb] <= dib;
        dob <= ram[addrb];
    end
end
//---------------------------------------------------------------------------------------
//
//						Finish		Moudle	
//
//---------------------------------------------------------------------------------------
endmodule